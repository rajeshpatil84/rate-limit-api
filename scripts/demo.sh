#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Rate Limiter API — Live Demo Script
#
# Usage:  ./scripts/demo.sh [BASE_URL]
#
# Demonstrates every client, algorithm, and storage combination required by
# the Showpad take-home spec, plus bonus features.
# ─────────────────────────────────────────────────────────────────────────────

BASE_URL="${1:-http://localhost:3000}"
PASS=0; FAIL=0

# ── Helpers ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'

section() { echo -e "\n${BOLD}${CYAN}━━━ $1 ━━━${RESET}"; }
info()    { echo -e "${YELLOW}▶ $1${RESET}"; }

hit() {
  local label="$1" url="$2" auth="$3" expected="$4"
  local response status body
  response=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$url" \
    -H "Authorization: Bearer $auth" -H "Accept: application/json")
  status="$response"

  body=$(curl -s -X GET "$url" -H "Authorization: Bearer $auth" \
    -H "Accept: application/json")

  if [[ "$status" == "$expected" ]]; then
    echo -e "  ${GREEN}✓${RESET} $label → HTTP $status  $body"
    ((PASS++))
  else
    echo -e "  ${RED}✗${RESET} $label → HTTP $status (expected $expected)  $body"
    ((FAIL++))
  fi
}

separator() { echo -e "  ${YELLOW}  ... (limit reached, waiting for window reset) ...${RESET}"; }

# ── Check server is up ────────────────────────────────────────────────────────
section "Health Check"
health=$(curl -s "$BASE_URL/admin/health")
if echo "$health" | grep -q '"ok"'; then
  echo -e "  ${GREEN}✓${RESET} Server is up: $health"
else
  echo -e "  ${RED}✗${RESET} Server not responding at $BASE_URL"
  echo "  Make sure the server is running:  npm run dev"
  exit 1
fi

# ── Client configs ─────────────────────────────────────────────────────────────
section "Registered Clients"
curl -s "$BASE_URL/admin/clients" | python3 -m json.tool 2>/dev/null \
  || curl -s "$BASE_URL/admin/clients"
echo ""

# ── AUTH VALIDATION ────────────────────────────────────────────────────────────
section "Authentication Validation"
hit "Missing header → 401"      "$BASE_URL/foo"  ""                 "401"
hit "Malformed header → 401"    "$BASE_URL/foo"  "not-bearer-format" "401"
hit "Unknown client → 403"      "$BASE_URL/foo"  "ghost-client"     "403"

# ── /foo  Fixed Window  (in-memory) ───────────────────────────────────────────
section "GET /foo — Fixed Window — In-Memory — client-1 (limit 5/10s)"
info "Firing 5 allowed requests..."
for i in $(seq 1 5); do
  hit "Request $i/5 → 200" "$BASE_URL/foo" "client-1" "200"
done
info "6th request should be throttled..."
hit "Request 6/5 → 429" "$BASE_URL/foo" "client-1" "429"

# ── /foo  Fixed Window  (in-memory) — client-2 is independent ─────────────────
section "GET /foo — client-2 (limit 10/10s) — isolated from client-1"
info "client-1 is still blocked; client-2 should pass..."
hit "client-2 Request 1 → 200" "$BASE_URL/foo" "client-2" "200"
hit "client-2 Request 2 → 200" "$BASE_URL/foo" "client-2" "200"

# ── /bar  Sliding Window  (in-memory) ─────────────────────────────────────────
section "GET /bar — Sliding Window — In-Memory — client-1 (limit 5/10s)"
info "Firing 5 allowed requests..."
for i in $(seq 1 5); do
  hit "Request $i/5 → 200" "$BASE_URL/bar" "client-1" "200"
done
info "6th request should be throttled..."
hit "Request 6/5 → 429" "$BASE_URL/bar" "client-1" "429"

# ── Storage comparison: /memory vs /sqlite ─────────────────────────────────────
section "Storage Comparison — /memory vs /sqlite prefix"
info "Exhaust client-free on /memory/foo (limit=2)..."
hit "/memory/foo req 1 → 200" "$BASE_URL/memory/foo" "client-free" "200"
hit "/memory/foo req 2 → 200" "$BASE_URL/memory/foo" "client-free" "200"
hit "/memory/foo req 3 → 429" "$BASE_URL/memory/foo" "client-free" "429"
info "Same client on /sqlite/foo — independent counter, should pass..."
hit "/sqlite/foo req 1 → 200" "$BASE_URL/sqlite/foo" "client-free" "200"
hit "/sqlite/foo req 2 → 200" "$BASE_URL/sqlite/foo" "client-free" "200"
hit "/sqlite/foo req 3 → 429" "$BASE_URL/sqlite/foo" "client-free" "429"

# ── Bonus endpoints ─────────────────────────────────────────────────────────────
section "Bonus: Token Bucket (/memory/baz) — allows bursts"
info "Token Bucket starts with a full bucket — fire 5 rapid requests..."
for i in $(seq 1 5); do
  hit "Burst req $i → 200" "$BASE_URL/memory/baz" "client-1" "200"
done
hit "Burst req 6 → 429" "$BASE_URL/memory/baz" "client-1" "429"

section "Bonus: Leaky Bucket (/memory/qux) — smooth drain"
for i in $(seq 1 5); do
  hit "Req $i → 200" "$BASE_URL/memory/qux" "client-1" "200"
done
hit "Req 6 → 429" "$BASE_URL/memory/qux" "client-1" "429"

# ── Premium client shows higher limits ─────────────────────────────────────────
section "Tier comparison: client-free (limit 2) vs client-premium (limit 100)"
hit "client-free  req 3 → 429"   "$BASE_URL/memory/foo" "client-free"    "429"
hit "client-premium req  → 200"  "$BASE_URL/memory/foo" "client-premium" "200"

# ── Admin state ──────────────────────────────────────────────────────────────
section "Admin: Rate-limit State"
info "In-memory keys:"
curl -s "$BASE_URL/admin/state/memory" | python3 -m json.tool 2>/dev/null \
  || curl -s "$BASE_URL/admin/state/memory"
echo ""
info "SQLite keys:"
curl -s "$BASE_URL/admin/state/sqlite" | python3 -m json.tool 2>/dev/null \
  || curl -s "$BASE_URL/admin/state/sqlite"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
section "Demo Summary"
TOTAL=$((PASS + FAIL))
echo -e "  ${GREEN}Passed: $PASS${RESET} / ${BOLD}$TOTAL${RESET}"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Failed: $FAIL${RESET}"
  exit 1
else
  echo -e "  ${GREEN}All assertions passed!${RESET}"
fi
