"""Keep the local service alive while at least one app document is connected."""
import asyncio
from contextlib import suppress


class WindowLifetime:
    def __init__(self, shutdown_callback, *, grace_seconds=5.0, startup_timeout=None):
        self.shutdown_callback = shutdown_callback
        self.grace_seconds = grace_seconds
        self.startup_timeout = startup_timeout
        self.windows = set()
        self.timer = None
        self.stopped = False

    def start(self):
        if self.startup_timeout is not None:
            self._schedule(self.startup_timeout)

    def connect(self):
        if self.stopped:
            return None
        self._cancel_timer()
        window = object()
        self.windows.add(window)
        return window

    def disconnect(self, window):
        if window not in self.windows:
            return
        self.windows.remove(window)
        if not self.windows and not self.stopped:
            self._schedule(self.grace_seconds)

    def _cancel_timer(self):
        timer, self.timer = self.timer, None
        if timer is not None and timer is not asyncio.current_task():
            timer.cancel()
        return timer

    def _schedule(self, delay):
        self._cancel_timer()
        self.timer = asyncio.create_task(self._wait_for_exit(delay))

    async def _wait_for_exit(self, delay):
        try:
            await asyncio.sleep(delay)
            if not self.windows:
                await self.shutdown()
        except asyncio.CancelledError:
            pass

    async def shutdown(self):
        if self.stopped:
            return
        self.stopped = True
        self._cancel_timer()
        self.shutdown_callback()

    async def close(self):
        self.stopped = True
        timer = self._cancel_timer()
        if timer is not None and timer is not asyncio.current_task():
            with suppress(asyncio.CancelledError):
                await timer
        self.windows.clear()
