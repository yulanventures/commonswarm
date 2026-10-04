# Test-only clock pin: with C1_TEST_FIXED_NOW set, datetime.datetime.now() returns that instant, so the plan's own
# blocks can judge the EXACT box-written sample times as fresh. Imported by Python only via this test PYTHONPATH.
import datetime as _datetime, os as _os
_fixed = _os.environ.get('C1_TEST_FIXED_NOW')
if _fixed:
    _at = _datetime.datetime.strptime(_fixed, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=_datetime.timezone.utc)
    class _PinnedDateTime(_datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return _at if tz is None else _at.astimezone(tz)
    _datetime.datetime = _PinnedDateTime
