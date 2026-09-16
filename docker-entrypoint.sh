#!/bin/sh
set -eu

# Render Free has an ephemeral filesystem. Materialize the account-store key
# from an environment secret when provided, avoiding fragile dashboard shell
# command overrides.
if [ -n "${WKB2API_ACCOUNT_STORE_KEY_B64:-}" ]; then
  key_file="${WKB2API_ACCOUNT_STORE_KEY_FILE:-/tmp/account-store.key}"
  old_umask=$(umask)
  umask 077
  mkdir -p "$(dirname "$key_file")"
  printf '%s' "$WKB2API_ACCOUNT_STORE_KEY_B64" > "$key_file"
  umask "$old_umask"
  export WKB2API_ACCOUNT_STORE_KEY_FILE="$key_file"
fi

exec "$@"
