#!/usr/bin/env bash
# Release-owner key custody for the marketplace two-level trust model.
#
#   generate-root    offline ROOT key -> login Keychain + 1Password; prints the public half only
#   generate-online  ONLINE signing key -> GitHub environment secret(s) only; prints the public half
#   sign-trust       sign a trust generation with the Keychain root key, then verify it
#   verify-backup    prove the Keychain and 1Password copies are identical and match a public key
#
# The commands that use the login Keychain (generate-root, sign-trust, verify-backup) run on macOS
# only; generate-online needs just gh + openssl and also runs on Linux.
#
# Private key material never appears on argv, stdout or stderr. It lives only in a 0600 file inside a
# 0700 temp dir (the CLI refuses FIFOs and /dev/fd), which is removed on every exit path after a
# best-effort overwrite (not a guarantee on APFS/SSD; FileVault is the real at-rest protection). The
# root key is stored in the Keychain and 1Password as the single-line base64 of the PKCS8 PEM, so no
# store has to round-trip newlines; the online key goes to GitHub as the raw PEM on stdin.
# See docs/MARKETPLACE_RELEASE_CONFIG.md ("Key custody runbook").
set -euo pipefail
umask 077

CADENCR_BIN=${CADENCR_BIN:-cadencr}
OP_BIN=${OP_BIN:-op}
SECURITY_BIN=${SECURITY_BIN:-security}
GH_BIN=${GH_BIN:-gh}
UNAME_BIN=${UNAME_BIN:-uname}
KEYCHAIN_SERVICE=${CADENCR_KEYS_SERVICE:-cadencr-marketplace-root}
DEFAULT_SECRET_NAME=CADENCR_REGISTRY_PRIVATE_KEY_PEM
ID_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
TITLE_RE='^[A-Za-z0-9 ._:@/+=()-]{1,128}$'
ED25519_SPKI_PREFIX=302a300506032b6570032100 # SEQUENCE{ SEQUENCE{ OID 1.3.101.112 }, BIT STRING(32) }

DRY_RUN=0
WORK=""
OPENSSL=""

usage() {
  cat <<'EOF'
Usage: marketplace-keys.sh <command> [options]

Commands
  generate-root    --key-id ID --vault VAULT [--item-title T] [--keychain PATH] [--public-pem-out FILE]
  generate-online  --key-id ID --repo OWNER/REPO --env NAME [--env NAME ...]
                   [--secret-name NAME] [--public-pem-out FILE]
  sign-trust       --payload FILE --output FILE --key-id ROOT_ID --root-public-key PEM
                   [--minimum-generation N] [--keychain PATH] [--force]
  verify-backup    --key-id ROOT_ID --vault VAULT
                   (--expected-public-key PEM | --expected-public-key-base64 B64)
                   [--item-title T] [--keychain PATH]

Global: --dry-run (print the plan, run nothing), -h/--help.
Keychain commands (generate-root, sign-trust, verify-backup) require macOS; generate-online does not.
Environment: CADENCR_BIN OP_BIN SECURITY_BIN GH_BIN OPENSSL_BIN UNAME_BIN, CADENCR_KEYS_SERVICE,
  CADENCR_KEYS_KEYCHAIN, CADENCR_KEYS_OP_VAULT, CADENCR_KEYS_ALLOW_NON_DARWIN=1 (tests only).
EOF
}

die() { printf 'marketplace-keys: error: %s\n' "$*" >&2; exit 1; }
info() { printf 'marketplace-keys: %s\n' "$*" >&2; }
plan() { printf 'plan: %s\n' "$*"; }

# ---- temp material -------------------------------------------------------------------------------

# Best-effort overwrite with random bytes, then remove. Not a guarantee on APFS/SSD (copy-on-write,
# wear levelling); the 0700 directory, short lifetime and FileVault are the real protection.
wipe_file() {
  local file=$1 size
  [ -f "$file" ] || return 0
  size=$(wc -c <"$file" | tr -d ' ')
  if [ "${size:-0}" -gt 0 ]; then
    dd if=/dev/urandom of="$file" bs="$size" count=1 conv=notrunc 2>/dev/null \
      || info "warning: could not overwrite a temporary file before removal"
  fi
  rm -f "$file"
}

wipe_work() {
  local dir=$WORK file
  WORK=""
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  while IFS= read -r file; do
    wipe_file "$file"
  done < <(find "$dir" -type f)
  rm -rf "$dir"
  [ ! -e "$dir" ] || info "warning: temporary directory $dir could not be removed; delete it manually"
}

trap 'wipe_work' EXIT
trap 'wipe_work; exit 130' INT
trap 'wipe_work; exit 143' TERM
trap 'wipe_work; exit 129' HUP

make_work() {
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/cadencr-keys.XXXXXX") || die "cannot create a temporary directory"
  chmod 700 "$WORK"
}

new_secret_file() { : >"$1"; chmod 600 "$1"; }

# ---- preflight -----------------------------------------------------------------------------------

require_darwin() {
  [ "${CADENCR_KEYS_ALLOW_NON_DARWIN:-}" = 1 ] && return 0
  [ "$("$UNAME_BIN" -s)" = Darwin ] \
    || die "this tool uses the macOS login Keychain and only runs on macOS (Darwin)"
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 || die "$2 not found: $1 (set $3 to override)"
}

resolve_openssl() {
  local candidate algorithms
  for candidate in "${OPENSSL_BIN:-}" openssl /opt/homebrew/opt/openssl@3/bin/openssl \
    /usr/local/opt/openssl@3/bin/openssl; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    algorithms=$("$candidate" list -public-key-algorithms 2>/dev/null || true)
    case $algorithms in
      *[Ee][Dd]25519*) OPENSSL=$candidate; return 0 ;;
    esac
  done
  die "no openssl with Ed25519 support found (macOS ships LibreSSL without it; brew install openssl@3 or set OPENSSL_BIN)"
}

check_id() { [[ $2 =~ $ID_RE ]] || die "$1 must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}: '$2'"; }

# Values interpolated into the `security -i` command line or the 1Password JSON template.
check_service() {
  [[ $KEYCHAIN_SERVICE =~ $ID_RE ]] \
    || die "CADENCR_KEYS_SERVICE must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}: '$KEYCHAIN_SERVICE'"
}

check_title() {
  [[ $ITEM_TITLE =~ $TITLE_RE ]] \
    || die "--item-title must be 1-128 characters from [A-Za-z0-9 ._:@/+=()-] (no quotes, backslashes, newlines or control characters)"
}

check_keychain() {
  case $1 in *'"'* | *'\'*) die "--keychain path must not contain quotes or backslashes" ;; esac
  [[ $1 =~ [[:cntrl:]] ]] && die "--keychain path must not contain newlines or control characters"
  return 0
}

# Refuse up front (before any side effect) to overwrite a public output file.
check_out_path() { # option path-or-empty
  [ -n "$2" ] || return 0
  if [ -e "$2" ] || [ -L "$2" ]; then die "refusing to overwrite existing $2"; fi
  [ -d "$(dirname -- "$2")" ] || die "$1: directory does not exist: $(dirname -- "$2")"
}

# ---- key helpers (operate on files in $WORK) -----------------------------------------------------

# Write the SPKI DER of a key file to out.der and require it to be an Ed25519 key: 44 bytes that start
# with the Ed25519 algorithm OID 1.3.101.112 (06 03 2b 65 70); X25519 etc. have the same length.
public_der() { # private|public key.pem out.der
  local kind=$1 label prefix
  case $kind in
    private) label="key"; "$OPENSSL" pkey -in "$2" -pubout -outform DER -out "$3" 2>/dev/null \
      || die "not a readable Ed25519 private key" ;;
    public) label="expected public key"; "$OPENSSL" pkey -pubin -in "$2" -outform DER -out "$3" 2>/dev/null \
      || die "expected public key is not a readable PEM" ;;
    *) die "internal error: public_der kind '$kind'" ;;
  esac
  prefix=$(head -c 12 "$3" | od -An -tx1 | tr -d ' \n')
  { [ "$(wc -c <"$3" | tr -d ' ')" = 44 ] && [ "$prefix" = "$ED25519_SPKI_PREFIX" ]; } \
    || die "$label is not Ed25519"
}

public_b64() { # key.pem -> base64 of the raw 32-byte public key
  public_der private "$1" "$WORK/pub.der"
  tail -c 32 "$WORK/pub.der" | "$OPENSSL" base64 -A
  rm -f "$WORK/pub.der"
}

public_pem() { "$OPENSSL" pkey -in "$1" -pubout 2>/dev/null; }

pem_to_stored() { "$OPENSSL" base64 -A -in "$1"; } # single-line base64 of the PEM

stored_to_file() { # $1 = stored value, $2 = destination key file
  new_secret_file "$2"
  printf '%s' "$1" | "$OPENSSL" base64 -d -A >"$2" 2>/dev/null \
    || die "stored key is not valid base64"
  "$OPENSSL" pkey -in "$2" -noout 2>/dev/null || die "stored key is not a PKCS8 PEM private key"
}

write_public_pem() { # key.pem dest-or-empty
  local pem
  pem=$(public_pem "$1")
  printf '%s\n' "$pem"
  if [ -n "$2" ]; then
    # Public data: world-readable 0644 (the script runs under umask 077). noclobber closes the race
    # with a file created after the up-front check.
    (umask 022; set -C; printf '%s\n' "$pem" >"$2") 2>/dev/null || die "cannot create $2 (refusing to overwrite an existing file)"
    info "wrote public key PEM: $2"
  fi
}

# ---- Keychain (secret travels over `security -i` stdin, never argv) -------------------------------

kc_exists() {
  local extra=()
  [ -z "$KEYCHAIN" ] || extra=("$KEYCHAIN")
  "$SECURITY_BIN" find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" ${extra[@]+"${extra[@]}"} >/dev/null 2>&1
}

kc_add() { # account stored-value; returns non-zero on failure (the caller words the error)
  local suffix=""
  [ -z "$KEYCHAIN" ] || suffix=" \"$KEYCHAIN\""
  printf 'add-generic-password -s "%s" -a "%s" -w "%s"%s\n' "$KEYCHAIN_SERVICE" "$1" "$2" "$suffix" \
    | "$SECURITY_BIN" -i >/dev/null || return 1
}

kc_read() { # account
  local extra=()
  [ -z "$KEYCHAIN" ] || extra=("$KEYCHAIN")
  "$SECURITY_BIN" find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" -w ${extra[@]+"${extra[@]}"} 2>/dev/null \
    || die "no Keychain item for service '$KEYCHAIN_SERVICE' account '$1'"
}

# ---- 1Password (item template travels over stdin) ------------------------------------------------

op_exists() { "$OP_BIN" item get "$2" --vault "$1" >/dev/null 2>&1; }

op_add() { # vault title stored-value
  printf '{"title":"%s","category":"SECURE_NOTE","fields":[{"id":"notesPlain","label":"notesPlain","type":"STRING","purpose":"NOTES","value":"%s"}]}' \
    "$2" "$3" | "$OP_BIN" item create --vault "$1" >/dev/null || die "1Password write failed"
}

op_read() { # vault title
  "$OP_BIN" item get "$2" --vault "$1" --fields notesPlain \
    || die "cannot read 1Password item '$2'"
}

# ---- option parsing ------------------------------------------------------------------------------

KEY_ID="" VAULT=${CADENCR_KEYS_OP_VAULT:-} ITEM_TITLE="" KEYCHAIN=${CADENCR_KEYS_KEYCHAIN:-}
PUBLIC_PEM_OUT="" PAYLOAD="" OUTPUT="" ROOT_PUBLIC="" MIN_GEN=1 FORCE=0 REPO="" SECRET_NAME=""
EXPECTED_PEM="" EXPECTED_B64="" ENVS=()

parse_opts() {
  while [ $# -gt 0 ]; do
    local opt=$1
    case $opt in
      --dry-run) DRY_RUN=1; shift; continue ;;
      --force) FORCE=1; shift; continue ;;
      -h | --help) usage; exit 0 ;;
      --key-id | --vault | --item-title | --keychain | --public-pem-out | --payload | --output \
        | --root-public-key | --minimum-generation | --repo | --env | --secret-name \
        | --expected-public-key | --expected-public-key-base64) ;;
      *) die "unknown option: $opt" ;;
    esac
    [ $# -ge 2 ] || die "$opt needs a value"
    local value=$2
    shift 2
    case $opt in
      --key-id) KEY_ID=$value ;;
      --vault) VAULT=$value ;;
      --item-title) ITEM_TITLE=$value ;;
      --keychain) KEYCHAIN=$value ;;
      --public-pem-out) PUBLIC_PEM_OUT=$value ;;
      --payload) PAYLOAD=$value ;;
      --output) OUTPUT=$value ;;
      --root-public-key) ROOT_PUBLIC=$value ;;
      --minimum-generation) MIN_GEN=$value ;;
      --repo) REPO=$value ;;
      --env) ENVS+=("$value") ;;
      --secret-name) SECRET_NAME=$value ;;
      --expected-public-key) EXPECTED_PEM=$value ;;
      --expected-public-key-base64) EXPECTED_B64=$value ;;
    esac
  done
}

need() { [ -n "$2" ] || die "missing required option $1"; }

# ---- commands ------------------------------------------------------------------------------------

cmd_generate_root() {
  need --key-id "$KEY_ID"; need --vault "$VAULT"
  check_id "--key-id" "$KEY_ID"; check_keychain "$KEYCHAIN"; check_service
  [ -n "$ITEM_TITLE" ] || ITEM_TITLE="cadencr-marketplace-root-$KEY_ID"
  check_title
  check_out_path --public-pem-out "$PUBLIC_PEM_OUT"
  if [ "$DRY_RUN" = 1 ]; then
    plan "generate an Ed25519 key in a 0700 temp dir (files 0600)"
    plan "refuse if Keychain item service='$KEYCHAIN_SERVICE' account='$KEY_ID' or 1Password item '$ITEM_TITLE' exists"
    plan "op item create (template on stdin) in the requested vault, title '$ITEM_TITLE'"
    plan "security -i add-generic-password service='$KEYCHAIN_SERVICE' account='$KEY_ID' (secret on stdin)"
    plan "read both copies back, require byte-identical, print key id + public key only"
    plan "best-effort overwrite, then remove, the temp dir (EXIT/INT/TERM/HUP)"
    return 0
  fi
  require_bin "$SECURITY_BIN" "security" SECURITY_BIN; require_bin "$OP_BIN" "1Password CLI" OP_BIN
  resolve_openssl
  kc_exists "$KEY_ID" && die "Keychain item already exists for account '$KEY_ID'; refusing to overwrite"
  op_exists "$VAULT" "$ITEM_TITLE" && die "1Password item '$ITEM_TITLE' already exists; refusing to overwrite"
  make_work
  new_secret_file "$WORK/root.pem"
  "$OPENSSL" genpkey -algorithm ED25519 -out "$WORK/root.pem" 2>/dev/null || die "key generation failed"
  local stored from_kc from_op pub
  stored=$(pem_to_stored "$WORK/root.pem")
  pub=$(public_b64 "$WORK/root.pem")
  op_add "$VAULT" "$ITEM_TITLE" "$stored"
  info "stored in 1Password"
  kc_add "$KEY_ID" "$stored" \
    || die "Keychain write failed AFTER the 1Password item '$ITEM_TITLE' was created in vault '$VAULT'; that item holds the only copy of this key. Remove it manually (nothing was deleted automatically) before re-running generate-root"
  info "stored in the login Keychain"
  from_op=$(op_read "$VAULT" "$ITEM_TITLE") || exit 1
  from_kc=$(kc_read "$KEY_ID") || exit 1
  if [ "$from_op" != "$stored" ] || [ "$from_kc" != "$stored" ]; then
    die "read-back mismatch: a store holds a different value than was generated; inspect both stores before using this key id"
  fi
  printf 'root key id: %s\n' "$KEY_ID"
  printf 'root public key (base64, raw 32 bytes): %s\n' "$pub"
  printf 'root public key (SPKI PEM):\n'
  write_public_pem "$WORK/root.pem" "$PUBLIC_PEM_OUT"
  info "root key stored in Keychain and 1Password; temp files wiped"
}

cmd_generate_online() {
  need --key-id "$KEY_ID"; need --repo "$REPO"
  check_id "--key-id" "$KEY_ID"
  check_out_path --public-pem-out "$PUBLIC_PEM_OUT"
  [ ${#ENVS[@]} -gt 0 ] || die "missing required option --env (repeat for publication and renewal environments)"
  [[ $REPO =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "--repo must be OWNER/REPO"
  [ -n "$SECRET_NAME" ] || SECRET_NAME=$DEFAULT_SECRET_NAME
  [[ $SECRET_NAME =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid --secret-name"
  local environment
  for environment in "${ENVS[@]}"; do
    [[ $environment =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid --env name: $environment"
  done
  if [ "$DRY_RUN" = 1 ]; then
    plan "generate an Ed25519 key in a 0700 temp dir (files 0600)"
    for environment in "${ENVS[@]}"; do
      plan "gh secret set $SECRET_NAME --env $environment --repo $REPO (PEM on stdin)"
    done
    plan "print key id + public key only; the private key is not stored anywhere else"
    plan "best-effort overwrite, then remove, the temp dir"
    return 0
  fi
  require_bin "$GH_BIN" "GitHub CLI" GH_BIN
  resolve_openssl
  make_work
  new_secret_file "$WORK/online.pem"
  "$OPENSSL" genpkey -algorithm ED25519 -out "$WORK/online.pem" 2>/dev/null || die "key generation failed"
  local pub uploaded=()
  pub=$(public_b64 "$WORK/online.pem")
  for environment in "${ENVS[@]}"; do
    if "$GH_BIN" secret set "$SECRET_NAME" --env "$environment" --repo "$REPO" <"$WORK/online.pem" >/dev/null; then
      uploaded+=("$environment")
    else
      die "gh secret set failed for environment '$environment' (uploaded: ${uploaded[*]:-none}); the key was not kept locally, re-run to generate a fresh one"
    fi
  done
  printf 'online key id: %s\n' "$KEY_ID"
  printf 'online public key (base64, raw 32 bytes): %s\n' "$pub"
  printf 'online public key (SPKI PEM):\n'
  write_public_pem "$WORK/online.pem" "$PUBLIC_PEM_OUT"
  info "uploaded $SECRET_NAME to: ${uploaded[*]}; local copy wiped"
}

cmd_sign_trust() {
  need --payload "$PAYLOAD"; need --output "$OUTPUT"; need --key-id "$KEY_ID"
  need --root-public-key "$ROOT_PUBLIC"
  check_id "--key-id" "$KEY_ID"; check_keychain "$KEYCHAIN"; check_service
  [[ $MIN_GEN =~ ^[1-9][0-9]*$ ]] || die "--minimum-generation must be a positive integer"
  [ -f "$PAYLOAD" ] || die "payload not found: $PAYLOAD"
  [ -f "$ROOT_PUBLIC" ] || die "root public key not found: $ROOT_PUBLIC"
  [ "$FORCE" = 1 ] || [ ! -e "$OUTPUT" ] || die "output exists: $OUTPUT (use --force to replace)"
  [ -d "$(dirname -- "$OUTPUT")" ] || die "--output: directory does not exist: $(dirname -- "$OUTPUT")"
  if [ "$DRY_RUN" = 1 ]; then
    plan "read the root key (service='$KEYCHAIN_SERVICE' account='$KEY_ID') from the Keychain into a 0600 file in a 0700 temp dir"
    plan "cadencr registry sign-trust-manifest --payload $PAYLOAD --root-private-key <temp> --root-key-id $KEY_ID --output <temp>"
    plan "best-effort overwrite, then remove, the temp key immediately after signing"
    plan "cadencr registry verify-trust-manifest --root-public-key $ROOT_PUBLIC --minimum-generation $MIN_GEN"
    plan "copy the verified manifest to $OUTPUT (mode 0644: public data)"
    return 0
  fi
  require_bin "$SECURITY_BIN" "security" SECURITY_BIN; require_bin "$CADENCR_BIN" "cadencr CLI" CADENCR_BIN
  resolve_openssl
  make_work
  local stored
  stored=$(kc_read "$KEY_ID") || exit 1
  stored_to_file "$stored" "$WORK/root.pem"
  stored=""
  "$CADENCR_BIN" registry sign-trust-manifest --payload "$PAYLOAD" --root-private-key "$WORK/root.pem" \
    --root-key-id "$KEY_ID" --output "$WORK/signed-trust.json" >&2 || die "signing failed"
  wipe_file "$WORK/root.pem" # key is no longer needed; the directory is still wiped on exit
  "$CADENCR_BIN" registry verify-trust-manifest --manifest "$WORK/signed-trust.json" \
    --root-public-key "$ROOT_PUBLIC" --root-key-id "$KEY_ID" --minimum-generation "$MIN_GEN" >&2 \
    || die "the signed manifest did not verify against the root public key; nothing was written"
  cp "$WORK/signed-trust.json" "$OUTPUT" && chmod 644 "$OUTPUT" || die "cannot write $OUTPUT"
  info "signed and verified trust manifest: $OUTPUT"
}

cmd_verify_backup() {
  need --key-id "$KEY_ID"; need --vault "$VAULT"
  check_id "--key-id" "$KEY_ID"; check_keychain "$KEYCHAIN"; check_service
  [ -n "$ITEM_TITLE" ] || ITEM_TITLE="cadencr-marketplace-root-$KEY_ID"
  check_title
  [ -n "$EXPECTED_PEM" ] || [ -n "$EXPECTED_B64" ] \
    || die "missing --expected-public-key PEM or --expected-public-key-base64"
  [ -z "$EXPECTED_PEM" ] || [ -f "$EXPECTED_PEM" ] || die "expected public key not found: $EXPECTED_PEM"
  if [ "$DRY_RUN" = 1 ]; then
    plan "read the Keychain item (service='$KEYCHAIN_SERVICE' account='$KEY_ID') and 1Password item '$ITEM_TITLE'"
    plan "compare them byte-for-byte and the derived public key with the expected one; print verdicts only"
    return 0
  fi
  require_bin "$SECURITY_BIN" "security" SECURITY_BIN; require_bin "$OP_BIN" "1Password CLI" OP_BIN
  resolve_openssl
  make_work
  local from_kc from_op expected derived
  from_kc=$(kc_read "$KEY_ID") || exit 1
  from_op=$(op_read "$VAULT" "$ITEM_TITLE") || exit 1
  [ "$from_kc" = "$from_op" ] || die "Keychain and 1Password copies DIFFER"
  stored_to_file "$from_kc" "$WORK/root.pem"
  from_kc="" from_op=""
  derived=$(public_b64 "$WORK/root.pem")
  if [ -n "$EXPECTED_B64" ]; then
    expected=$EXPECTED_B64
  else
    public_der public "$EXPECTED_PEM" "$WORK/expected.der"
    expected=$(tail -c 32 "$WORK/expected.der" | "$OPENSSL" base64 -A)
  fi
  [ "$derived" = "$expected" ] || die "stored key does not match the expected public key"
  printf 'keychain: present\n1password: present\ncopies: identical\npublic key: matches expected\n'
}

main() {
  [ $# -gt 0 ] || { usage >&2; exit 2; }
  local command=$1
  shift
  case $command in
    -h | --help) usage; exit 0 ;;
    generate-root | generate-online | sign-trust | verify-backup) ;;
    *) usage >&2; die "unknown command: $command" ;;
  esac
  parse_opts "$@"
  case $command in
    generate-root | sign-trust | verify-backup) require_darwin ;; # Keychain users; generate-online is portable
  esac
  case $command in
    generate-root) cmd_generate_root ;;
    generate-online) cmd_generate_online ;;
    sign-trust) cmd_sign_trust ;;
    verify-backup) cmd_verify_backup ;;
  esac
}

main "$@"
