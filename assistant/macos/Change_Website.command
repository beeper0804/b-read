#!/bin/bash
root="$(cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
exec /bin/bash "$root/Start_Assistant.command" --change-website
