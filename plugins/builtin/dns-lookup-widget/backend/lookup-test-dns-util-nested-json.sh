#!/bin/sh

printf '{"reason":"blocked","details":"line 1\\nline 2"}\n' >&2
exit 1
