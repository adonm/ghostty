//! pty-bridge — Tiny PTY bridge for the Deno WebSocket server.
//!
//! Standalone Zig executable. Links libc for openpty/forkpty.
//! Spawns a shell in a PTY. Bridges stdin→PTY and PTY→stdout.
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
        // Child: setsid + dup slave to stdio + exec shell
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

    // Parent: bridge I/O between stdin/stdout and PTY master
    const stdin_thread = try std.Thread.spawn(.{}, struct {
        fn run(fd: posix.fd_t) void {
            var buf: [4096]u8 = undefined;
            while (true) {
                const n = posix.read(posix.STDIN_FILENO, &buf) catch break;
                if (n == 0) {
                    // EOF on stdin: send ^D to signal shell, then stop writing.
                    // Don't close the PTY fd — the stdout thread still needs it.
                    _ = posix.write(fd, &[_]u8{0x04}) catch {};
                    break;
                }
                _ = posix.write(fd, buf[0..n]) catch break;
            }
        }
    }.run, .{master_fd});

    const stdout_thread = try std.Thread.spawn(.{}, struct {
        fn run(fd: posix.fd_t) void {
            var buf: [4096]u8 = undefined;
            while (true) {
                const n = posix.read(fd, &buf) catch break;
                if (n == 0) break;
                _ = posix.write(posix.STDOUT_FILENO, buf[0..n]) catch break;
            }
        }
    }.run, .{master_fd});

    // Wait for child
    var status: c_int = undefined;
    _ = c.waitpid(pid, &status, 0);

    stdin_thread.join();
    stdout_thread.join();
}
