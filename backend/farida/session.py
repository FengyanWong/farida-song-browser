"""Local credentials only; never exposed through the catalog or frontend API."""
import ctypes
import json
import os
import tempfile
from pathlib import Path


class SessionError(ValueError):
    pass


def protect(data, decrypt=False):
    """Windows DPAPI, scoped to the current Windows user, with no interactive UI."""
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]

    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, target = Blob(len(data), buffer), Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p if decrypt else wintypes.LPCWSTR,
                         ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not function(ctypes.byref(source), None if decrypt else 'Farida Bilibili login',
                    None, None, None, 1, ctypes.byref(target)):
        raise SessionError('无法读取或保护本机登录信息，请在采集来源中重新登录。')
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel.LocalFree(target.data)


def validate_cookie(value):
    if not isinstance(value, str) or len(value) > 32768 or any(ord(c) < 32 or ord(c) > 126 for c in value):
        raise SessionError('本地登录信息格式无效，请重新登录。')
    return value


class SessionStore:
    def __init__(self, settings):
        self.settings = settings
        self.path = Path(settings.data_dir) / 'bilibili-session.dat'

    def load(self):
        try:
            if self.path.exists():
                raw = self.path.read_bytes()
                if len(raw) > 131072:
                    raise ValueError('oversized session')
                if raw == b'FARIDA-SIGNED-OUT\n':
                    return {'cookie': '', 'account': None}
                if raw.startswith(b'FARIDA-DPAPI-1\n') and os.name == 'nt':
                    raw = protect(raw.split(b'\n', 1)[1], decrypt=True)
                elif raw.startswith(b'FARIDA-PRIVATE-1\n') and os.name != 'nt':
                    raw = raw.split(b'\n', 1)[1]
                else:
                    raise ValueError('unknown local session format')
                record = json.loads(raw)
                validate_cookie(record['cookie'])
                account = record.get('account')
                if account is not None and (not isinstance(account, dict) or not str(account.get('uid', '')).isdigit() or not isinstance(account.get('name', ''), str)):
                    raise ValueError('invalid account')
                return record
            if self.settings.cookie_file:
                cookie = validate_cookie(self.settings.cookie_file.read_text(encoding='utf-8').strip())
                return {'cookie': cookie, 'account': None}
            return {'cookie': '', 'account': None}
        except (OSError, ValueError, KeyError, TypeError):
            raise SessionError('未能读取本机保存的登录信息。') from None

    def cookie_header(self):
        return self.load()['cookie']

    def _write(self, raw):
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix='.bilibili-session-', dir=self.path.parent)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        except OSError:
            raise SessionError('无法保存登录信息，请检查本地数据文件夹是否可写。') from None
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def save(self, cookie, account):
        raw = json.dumps({'cookie': validate_cookie(cookie), 'account': account}, ensure_ascii=False).encode('utf-8')
        raw = b'FARIDA-DPAPI-1\n' + protect(raw) if os.name == 'nt' else b'FARIDA-PRIVATE-1\n' + raw
        self._write(raw)

    def clear(self):
        # The marker also disables a legacy FARIDA_COOKIE_FILE without deleting it.
        self._write(b'FARIDA-SIGNED-OUT\n')
