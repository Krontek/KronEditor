/*
 * gpiod.h  --  libgpiod stub for KronEditor HAL
 *
 * This is a NO-OP stub so the project links without libgpiod installed.
 * GPIO operations will silently return failure (OK=false) until the real
 * libgpiod is provided.
 *
 * To enable real GPIO:
 *   1. Cross-compile libgpiod for aarch64:
 *        git clone https://git.kernel.org/pub/scm/libs/libgpiod/libgpiod.git
 *        cd libgpiod && ./autogen.sh
 *        ./configure --host=aarch64-none-linux-gnu \
 *                    CC=<toolchain>/aarch64-none-linux-gnu-gcc \
 *                    --enable-static --disable-shared \
 *                    --disable-tools --disable-bindings-cxx
 *        make -C lib
 *   2. Copy lib/.libs/libgpiod.a  →  resources/arm/aarch64/libgpiod.a
 *   3. Replace this file with the real gpiod.h from the libgpiod source tree.
 */

#ifndef GPIOD_H
#define GPIOD_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque handle types */
struct gpiod_chip { int _fd; };
struct gpiod_line { int _fd; int _offset; };

static inline struct gpiod_chip *gpiod_chip_open(const char *path)
    { (void)path; return NULL; }

static inline void gpiod_chip_close(struct gpiod_chip *chip)
    { (void)chip; }

static inline struct gpiod_line *gpiod_chip_get_line(struct gpiod_chip *chip, unsigned int offset)
    { (void)chip; (void)offset; return NULL; }

static inline void gpiod_line_release(struct gpiod_line *line)
    { (void)line; }

static inline int gpiod_line_request_input(struct gpiod_line *line, const char *consumer)
    { (void)line; (void)consumer; return -1; }

static inline int gpiod_line_request_output(struct gpiod_line *line, const char *consumer, int default_val)
    { (void)line; (void)consumer; (void)default_val; return -1; }

static inline int gpiod_line_get_value(struct gpiod_line *line)
    { (void)line; return -1; }

static inline int gpiod_line_set_value(struct gpiod_line *line, int value)
    { (void)line; (void)value; return -1; }

#ifdef __cplusplus
}
#endif

#endif /* GPIOD_H */
