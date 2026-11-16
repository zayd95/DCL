#!/usr/bin/env bash
# Usage : PGHOST=... PGPORT=... PGUSER=postgres ./supabase/tests/run.sh
# Recrée une base "depotek_test", applique le stub Supabase + migrations + tests.
set -euo pipefail
cd "$(dirname "$0")/../.."
P="psql -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists depotek_test" -c "create database depotek_test"
$P -d depotek_test -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do $P -d depotek_test -f "$f"; done
$P -d depotek_test -f supabase/tests/01_business_flow.sql
