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

    def connect(self, send_state):
        if self.stopped:
            return False
        self._cancel_timer()
        self.windows.add(send_state)
        return True

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

    @staticmethod
    async def notify_stopping(windows):
        async def notify(send_state):
            # A tab can disappear while its frame is in flight.
            with suppress(Exception):
                await send_state('stopping')

        sends = [asyncio.create_task(notify(send_state)) for send_state in windows]
        if sends:
            try:
                # All windows share one deadline, even if a transport stalls.
                await asyncio.wait(sends, timeout=0.5)
            finally:
                for send in sends:
                    if not send.done():
                        send.cancel()

    async def shutdown(self):
        if self.stopped:
            return
        self.stopped = True
        self._cancel_timer()
        try:
            await self.notify_stopping(self.windows)
        finally:
            self.shutdown_callback()

    async def close(self):
        self.stopped = True
        timer = self._cancel_timer()
        if timer is not None and timer is not asyncio.current_task():
            with suppress(asyncio.CancelledError):
                await timer
        self.windows.clear()
