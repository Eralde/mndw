#!/bin/sh

printf 'lookup failed: backslash=\\ quote=" tab=\t carriage=\r\n' >&2
printf 'second line\n' >&2
exit 1
