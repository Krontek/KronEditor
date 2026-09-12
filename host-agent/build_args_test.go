package main

import "testing"

// The output-containment check on req.Output is worthless if compilerArgs can
// redirect the compiler anyway, which is exactly what an unfiltered passthrough
// allowed (gcc/clang honour the LAST -o). Both halves of the fix are asserted
// here: the denied shapes, and the everyday flags that must keep working.
func TestRejectedCompilerArg(t *testing.T) {
	denied := [][]string{
		{"-o", "/home/user/.ssh/authorized_keys"},
		{"-o/etc/passwd"},
		{"--output=/tmp/x"},
		{"-Wl,-o,/tmp/x"},
		{"-Wl,--output=/tmp/x"},
		{"-Xlinker", "-o"},
		{"-fplugin=/tmp/evil.so"},
		{"-B/tmp/fakebin"},
		{"-specs=/tmp/evil.specs"},
		{"-Xclang", "-load"},
		{"-T/tmp/evil.ld"},
		{"-wrapper", "/tmp/evil"},
		{"@/tmp/args"},
		{"-I.", "-O2", "-o", "/tmp/x"}, // a bad arg among good ones
	}
	for _, args := range denied {
		if got := rejectedCompilerArg(args); got == "" {
			t.Errorf("rejectedCompilerArg(%q) = \"\", want a rejection", args)
		}
	}

	allowed := []string{
		"-I/usr/include", "-Iinclude", "-L/usr/lib", "-lm", "-O2", "-O0", "-Os",
		"-g", "-Wall", "-Wextra", "-Wl,-rpath,/usr/lib", "-std=c11", "-static",
		"-pthread", "-fPIC", "-DFOO=1", "-D", "FOO", "--target=aarch64-linux-gnu",
		"--sysroot=/opt/sysroot", "-isysroot", "/opt/sdk", "libkron.a", "-mcpu=cortex-a53",
	}
	if got := rejectedCompilerArg(allowed); got != "" {
		t.Errorf("rejectedCompilerArg rejected legitimate arg %q", got)
	}
	if got := rejectedCompilerArg(nil); got != "" {
		t.Errorf("rejectedCompilerArg(nil) = %q, want \"\"", got)
	}
}
