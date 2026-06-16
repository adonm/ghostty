//! pty-bridge — Tiny PTY bridge for the Deno WebSocket server.
//!
//! Standalone Zig executable. Links libc for openpty/forkpty.
//! Spawns a shell in a PTY. Bridges stdin→PTY and PTY→stdout.
//! Handles terminal query handshake (DSR/DA) so shells like bash
//! don't hang waiting for responses.
//!
//! Build:  zig build-exe -OReleaseSmall -lc pty_bridge.zig
//! Usage:  pty-bridge [shell]

const std = @import("std");
const posix = std.posix;
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("pty.h");
    @cInclude("stdlib.h");
    @cInclude("unistd.h");
    @cInclude("sys/ioctl.h");
    @cInclude("signal.h");
    @cInclude("sys/wait.h");
});

comptime {
    if (builtin.os.tag == .windows) {
        @compileError("pty-bridge is not supported on Windows");
    }
}

pub fn main() !void {
    const shell = blk: {
        var args = try std.process.argsWithAllocator(std.heap.page_allocator);
        defer args.deinit();
        _ = args.skip();
        break :blk args.next() orelse "/bin/bash";
    };

    // Create PTY and fork
    var master_fd: posix.fd_t = undefined;
    var slave_fd: posix.fd_t = undefined;
    var winsize = c.struct_winsize{
        .ws_row = 24,
        .ws_col = 80,
        .ws_xpixel = 0,
        .ws_ypixel = 0,
    };

    if (c.openpty(&master_fd, &slave_fd, null, null, &winsize) < 0) {
        std.debug.print("openpty failed\n", .{});
        return error.OpenptyFailed;
    }

    const pid = c.fork();
    if (pid < 0) {
        std.debug.print("fork failed\n", .{});
        return error.ForkFailed;
    }

    if (pid == 0) {
        _ = c.setsid();
        _ = c.ioctl(slave_fd, c.TIOCSCTTY, @as(c_int, 0));
        _ = c.dup2(slave_fd, posix.STDIN_FILENO);
        _ = c.dup2(slave_fd, posix.STDOUT_FILENO);
        _ = c.dup2(slave_fd, posix.STDERR_FILENO);
        if (slave_fd > posix.STDERR_FILENO) _ = c.close(slave_fd);
        _ = c.setenv("TERM", "xterm-256color", 1);
        _ = c.setenv("COLORTERM", "truecolor", 1);
        const shell_null: [*:0]const u8 = shell.ptr;
        const argv = [_]?[*:0]const u8{ shell_null, null };
        _ = c.execvp(shell_null, @ptrCast(&argv));
        c._exit(127);
    }

    _ = c.close(slave_fd);

    // stdin → PTY
    const stdin_thread = try std.Thread.spawn(.{}, struct {
        fn run(fd: posix.fd_t) void {
            var buf: [4096]u8 = undefined;
            while (true) {
                const n = posix.read(posix.STDIN_FILENO, &buf) catch break;
                if (n == 0) {
                    _ = posix.write(fd, &[_]u8{0x04}) catch {};
                    break;
                }
                _ = posix.write(fd, buf[0..n]) catch break;
            }
        }
    }.run, .{master_fd});

    // PTY → stdout (with VT query interception)
    const stdout_thread = try std.Thread.spawn(.{}, struct {
        fn run(fd: posix.fd_t) void {
            var buf: [4096]u8 = undefined;
            var scanner = VtScanner{};
            while (true) {
                const n = posix.read(fd, &buf) catch break;
                if (n == 0) break;

                // Scan and respond to terminal queries in the buffer
                scanner.scan(buf[0..n], fd);

                // Forward all data to stdout
                _ = posix.write(posix.STDOUT_FILENO, buf[0..n]) catch break;
            }
        }
    }.run, .{master_fd});

    var status: c_int = undefined;
    _ = c.waitpid(pid, &status, 0);
    stdin_thread.join();
    stdout_thread.join();
}

// ── VT query scanner ──────────────────────────────────────────────

const MAX_RESPONSES = 32; // Only handle the initial handshake

const VtScanner = struct {
    count: usize = 0,
    // State for CSI sequence parsing
    state: enum { ground, esc, csi_param, osc_string, osc_st } = .ground,
    csi_buf: [32]u8 = undefined,
    csi_len: usize = 0,

    fn scan(self: *VtScanner, data: []const u8, pty_fd: posix.fd_t) void {
        if (self.count >= MAX_RESPONSES) return;

        for (data) |b| {
            switch (self.state) {
                .ground => {
                    if (b == 0x1b) {
                        self.state = .esc;
                    }
                    // Also handle BEL as OSC terminator at ground level
                },
                .esc => {
                    if (b == 0x5b) { // '['
                        self.state = .csi_param;
                        self.csi_len = 0;
                    } else if (b == 0x5d) { // ']'
                        self.state = .osc_string;
                        self.csi_len = 0;
                    } else {
                        self.state = .ground;
                    }
                },
                .csi_param => {
                    if (self.csi_len < self.csi_buf.len) {
                        self.csi_buf[self.csi_len] = b;
                        self.csi_len += 1;
                    }
                    // Check for final byte (0x40-0x7e)
                    if (b >= 0x40 and b <= 0x7e) {
                        self.handleCsi(pty_fd);
                        self.state = .ground;
                    }
                },
                .osc_string => {
                    // OSC terminates with BEL (0x07) or ST (ESC \)
                    if (b == 0x07) {
                        self.handleOsc(pty_fd);
                        self.state = .ground;
                    } else if (b == 0x1b) {
                        self.state = .osc_st;
                    } else if (self.csi_len < self.csi_buf.len) {
                        self.csi_buf[self.csi_len] = b;
                        self.csi_len += 1;
                    }
                },
                .osc_st => {
                    if (b == 0x5c) { // '\'
                        self.handleOsc(pty_fd);
                    }
                    self.state = .ground;
                },
            }
        }
    }

    fn handleCsi(self: *VtScanner, pty_fd: posix.fd_t) void {
        if (self.count >= MAX_RESPONSES) return;
        const cmd = self.csi_buf[0..self.csi_len];

        // CSI 6 n — DSR cursor position
        if (cmd.len >= 2 and cmd[0] == '6' and cmd[cmd.len - 1] == 'n') {
            _ = posix.write(pty_fd, "\x1B[1;1R") catch {};
            self.count += 1;
        }
        // CSI c or CSI 0 c — Primary DA
        else if ((cmd.len >= 1 and cmd[0] == 'c') or
            (cmd.len >= 2 and cmd[0] == '0' and cmd[1] == 'c'))
        {
            _ = posix.write(pty_fd, "\x1B[?1;0c") catch {};
            self.count += 1;
        }
        // CSI > c — Secondary DA
        else if (cmd.len >= 2 and cmd[0] == '>' and cmd[1] == 'c') {
            _ = posix.write(pty_fd, "\x1B[>1;10;0c") catch {};
            self.count += 1;
        }
        // CSI 5 n — operating status
        else if (cmd.len >= 2 and cmd[0] == '5' and cmd[cmd.len - 1] == 'n') {
            _ = posix.write(pty_fd, "\x1B[0n") catch {};
            self.count += 1;
        }
    }

    fn handleOsc(self: *VtScanner, pty_fd: posix.fd_t) void {
        if (self.count >= MAX_RESPONSES) return;
        const cmd = self.csi_buf[0..self.csi_len];

        // OSC 11 ; ? — background color query
        if (cmd.len >= 3 and cmd[0] == '1' and cmd[1] == '1' and cmd[2] == ';') {
            if (cmd.len >= 4 and cmd[3] == '?') {
                _ = posix.write(pty_fd, "\x1B]11;rgb:0000/0000/0000\x1B\\") catch {};
                self.count += 1;
            }
        }
    }
};
