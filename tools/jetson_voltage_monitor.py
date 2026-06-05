#!/usr/bin/env python3
"""Jetson Nano power-rail monitor.

Reads the on-board INA3221 power monitor over sysfs (no extra packages) and
logs the input rail (VDD_IN, nominal 5 V) voltage / current / power. Flags
under-voltage dips and correlates them with USB disconnect / under-voltage
kernel messages, so you can tell whether the RPLIDAR motor stalls because the
5 V rail is browning out under load.

Usage:
    sudo python3 jetson_voltage_monitor.py                 # 2 Hz, default thresholds
    sudo python3 jetson_voltage_monitor.py --interval 0.2  # 5 Hz sampling
    sudo python3 jetson_voltage_monitor.py --warn 4.75 --crit 4.6
"""

import argparse
import glob
import os
import re
import subprocess
import sys
import time


def _read_int(path):
    try:
        with open(path) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def _read_str(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def _listdir(path):
    try:
        return sorted(os.listdir(path))
    except OSError:
        return []


def _ina_device_dirs():
    """Yield the per-chip device dirs, e.g. .../ina3221x/6-0040/.

    NB: never recurse with glob '**' under sysfs — the 'subsystem'/'device'
    back-link symlinks form cycles and blow up with 'Too many levels of
    symbolic links'. We descend a fixed, known depth instead.
    """
    for drv in glob.glob("/sys/bus/i2c/drivers/ina3221*"):
        for name in _listdir(drv):                 # e.g. '6-0040', 'module', 'bind'
            if re.match(r"\d+-[0-9a-fA-F]+$", name):
                yield os.path.join(drv, name)


def discover_rails():
    """Return [(label, voltage_path, current_path, power_path), ...].

    Handles both INA3221 sysfs layouts seen on Jetson Nano:
      * IIO style  (older JetPack): .../iio:deviceN/in_voltageC_input (mV)
      * hwmon style (newer):        .../hwmon/hwmonN/inC_input        (mV)
    Voltage files are mV, current files mA, power files mW.
    """
    rails = []

    # Collect the candidate measurement dirs at a FIXED depth (no symlink walk).
    iio_dirs, hwmon_dirs = [], []
    for dev in _ina_device_dirs():
        for sub in _listdir(dev):
            if sub.startswith("iio:device"):
                iio_dirs.append(os.path.join(dev, sub))
        hwmon_root = os.path.join(dev, "hwmon")
        for hw in _listdir(hwmon_root):
            if hw.startswith("hwmon"):
                hwmon_dirs.append(os.path.join(hwmon_root, hw))

    # --- IIO style: in_voltageC_input / in_currentC_input / in_powerC_input ---
    for base in iio_dirs:
        for fn in _listdir(base):
            m = re.match(r"in_voltage(\d+)_input$", fn)
            if not m:
                continue
            ch = m.group(1)
            label = (_read_str(os.path.join(base, f"rail_name_{ch}"))
                     or _read_str(os.path.join(base, f"in_voltage{ch}_label"))
                     or f"channel{ch}")
            rails.append((
                label,
                os.path.join(base, fn),
                os.path.join(base, f"in_current{ch}_input"),
                os.path.join(base, f"in_power{ch}_input"),
            ))

    # --- hwmon style: inC_input / currC_input / powerC_input ---
    if not rails:
        for base in hwmon_dirs:
            for fn in _listdir(base):
                m = re.match(r"in(\d+)_input$", fn)
                if not m:
                    continue
                ch = m.group(1)
                label = (_read_str(os.path.join(base, f"in{ch}_label"))
                         or f"channel{ch}")
                rails.append((
                    label,
                    os.path.join(base, fn),
                    os.path.join(base, f"curr{ch}_input"),
                    os.path.join(base, f"power{ch}_input"),
                ))

    return rails


def pick_input_rail(rails):
    """Heuristically find the main 5 V input rail (VDD_IN / POM_5V_IN)."""
    for label, *_ in rails:
        if re.search(r"(vdd_in|5v_in|pom_5v_in|sys5v|in\b)", label, re.I):
            return label
    return rails[0][0] if rails else None


def last_usb_kernel_events(since_lines=2000):
    """Grep recent dmesg for USB / under-voltage / brownout hints."""
    try:
        out = subprocess.run(
            ["dmesg", "--ctime"], capture_output=True, text=True, timeout=5
        ).stdout.splitlines()
    except Exception:
        return []
    pat = re.compile(
        r"(under-?voltage|brownout|over-?current|"
        r"usb .*(disconnect|reset|device number)|"
        r"new (full|high|low)-speed usb)", re.I)
    return [ln for ln in out[-since_lines:] if pat.search(ln)]


def main():
    ap = argparse.ArgumentParser(description="Jetson Nano INA3221 power monitor")
    ap.add_argument("--interval", type=float, default=0.5,
                    help="sampling period in seconds (default 0.5)")
    ap.add_argument("--warn", type=float, default=4.75,
                    help="warn threshold for input rail in volts (default 4.75)")
    ap.add_argument("--crit", type=float, default=4.60,
                    help="critical threshold in volts (default 4.60)")
    ap.add_argument("--all-rails", action="store_true",
                    help="print every rail, not just the input rail")
    args = ap.parse_args()

    rails = discover_rails()
    if not rails:
        print("ERROR: no INA3221 sysfs node found.\n"
              "  - Are you on a Jetson Nano with the INA3221 enabled?\n"
              "  - Try: ls /sys/bus/i2c/drivers/ina3221*/", file=sys.stderr)
        sys.exit(1)

    input_label = pick_input_rail(rails)
    print(f"Detected {len(rails)} rail(s): {', '.join(r[0] for r in rails)}")
    print(f"Tracking input rail: {input_label}")
    print(f"Thresholds: warn < {args.warn:.3f} V, crit < {args.crit:.3f} V\n")

    vmin = float("inf")
    crit_hits = 0
    samples = 0
    t0 = time.monotonic()

    try:
        while True:
            samples += 1
            line_parts = []
            input_v = None
            for label, vpath, cpath, ppath in rails:
                v = _read_int(vpath)      # mV
                c = _read_int(cpath)      # mA
                p = _read_int(ppath)      # mW
                if v is None:
                    continue
                volts = v / 1000.0
                amps = (c / 1000.0) if c is not None else None
                watts = (p / 1000.0) if p is not None else None
                if label == input_label:
                    input_v = volts
                if args.all_rails or label == input_label:
                    seg = f"{label}={volts:.3f}V"
                    if amps is not None:
                        seg += f"/{amps:.3f}A"
                    if watts is not None:
                        seg += f"/{watts:.2f}W"
                    line_parts.append(seg)

            tag = ""
            if input_v is not None:
                vmin = min(vmin, input_v)
                if input_v < args.crit:
                    tag = "  <<< CRITICAL UNDERVOLTAGE"
                    crit_hits += 1
                elif input_v < args.warn:
                    tag = "  << low"

            elapsed = time.monotonic() - t0
            print(f"[{elapsed:7.1f}s] " + "  ".join(line_parts) + tag)
            time.sleep(args.interval)

    except KeyboardInterrupt:
        print("\n--- summary ---")
        print(f"samples: {samples}, input rail min: {vmin:.3f} V, "
              f"critical dips: {crit_hits}")
        events = last_usb_kernel_events()
        if events:
            print("\nRecent USB / power kernel events (dmesg):")
            for ln in events[-20:]:
                print("  " + ln)
        else:
            print("\nNo USB/undervoltage kernel events found in recent dmesg.")
        if crit_hits:
            print("\n=> Input rail dropped below the critical threshold. "
                  "This is consistent with a USB power brownout stalling the "
                  "RPLIDAR motor. Use a stronger supply (barrel jack 4A + J48 "
                  "jumper) and/or a powered USB hub for the lidar.")


if __name__ == "__main__":
    main()
