#!/usr/bin/env perl
# ============================================================================
# Idempotency normalizer for historical Supabase migrations.
# Reads one migration on STDIN, writes a re-runnable version on STDOUT.
# Transformations are applied ONLY outside dollar-quoted bodies so function
# source code is never rewritten.
#   CREATE TABLE/INDEX/SEQUENCE      -> ... IF NOT EXISTS
#   ADD COLUMN                       -> ADD COLUMN IF NOT EXISTS
#   ADD CONSTRAINT                   -> preceded by DROP CONSTRAINT IF EXISTS
#   CREATE POLICY x ON t             -> preceded by DROP POLICY IF EXISTS
#   CREATE TRIGGER x ... ON t        -> preceded by DROP TRIGGER IF EXISTS
#   CREATE TYPE ...;                 -> DO block swallowing duplicate_object
#   CREATE FUNCTION / VIEW           -> CREATE OR REPLACE ...
#   CREATE EXTENSION pg_cron|pg_net  -> removed (preinstalled + vendor guarded)
#   CREATE EXTENSION other           -> IF NOT EXISTS
# ============================================================================
use strict;
use warnings;

local $/;
my $sql = <STDIN>;
$sql = '' unless defined $sql;

# Split on dollar-quote tags; even indexes are plain code, tags toggle bodies.
my @chunks = split /(\$[A-Za-z_]\w*?\$|\$\$)/, $sql;
my $open;
my $out = '';

for my $i (0 .. $#chunks) {
  my $chunk = $chunks[$i];
  next unless defined $chunk;

  if ($chunk =~ /^\$[A-Za-z_]?\w*\$$/ && $i % 2 == 1) {
    if (defined $open && $open eq $chunk) { undef $open; }
    elsif (!defined $open)               { $open = $chunk; }
    $out .= $chunk;
    next;
  }

  if (defined $open) { $out .= $chunk; next; }   # inside a function body
  $out .= normalize($chunk);
}

print $out;

sub normalize {
  my ($c) = @_;

  # Extensions guarded by the self-hosted image's vendor after-create script.
  $c =~ s/^[ \t]*CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(?:pg_cron|pg_net)"?[^;]*;[ \t]*\r?\n?//gim;
  $c =~ s/\bCREATE\s+EXTENSION\s+(?!IF\s+NOT\s+EXISTS)/CREATE EXTENSION IF NOT EXISTS /gi;

  $c =~ s/\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/CREATE TABLE IF NOT EXISTS /gi;
  $c =~ s/\bCREATE\s+UNIQUE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS|CONCURRENTLY)/CREATE UNIQUE INDEX IF NOT EXISTS /gi;
  $c =~ s/\bCREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS|CONCURRENTLY)/CREATE INDEX IF NOT EXISTS /gi;
  $c =~ s/\bCREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS)/CREATE SEQUENCE IF NOT EXISTS /gi;
  $c =~ s/\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/ADD COLUMN IF NOT EXISTS /gi;
  $c =~ s/\bCREATE\s+FUNCTION\b/CREATE OR REPLACE FUNCTION/gi;
  $c =~ s/\bCREATE\s+VIEW\b/CREATE OR REPLACE VIEW/gi;
  $c =~ s/\bCREATE\s+MATERIALIZED\s+VIEW\s+(?!IF\s+NOT\s+EXISTS)/CREATE MATERIALIZED VIEW IF NOT EXISTS /gi;

  # DROP POLICY before CREATE POLICY (policy name may be quoted).
  $c =~ s{\bCREATE\s+POLICY\s+("(?:[^"]|"")+"|[A-Za-z_]\w*)\s+ON\s+([\w."]+)}
         {DROP POLICY IF EXISTS $1 ON $2;\nCREATE POLICY $1 ON $2}gis;

  # DROP TRIGGER before CREATE TRIGGER (table name follows the timing clause).
  $c =~ s{\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+("(?:[^"]|"")+"|[A-Za-z_]\w*)((?:\s|\r|\n)+(?:BEFORE|AFTER|INSTEAD\s+OF)\b.*?\bON\s+([\w."]+))}
         {DROP TRIGGER IF EXISTS $1 ON $3;\nCREATE TRIGGER $1$2}gis;

  # ADD CONSTRAINT is not IF NOT EXISTS-able; drop first when it is named.
  $c =~ s{\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."]+)\s+ADD\s+CONSTRAINT\s+("(?:[^"]|"")+"|[A-Za-z_]\w*)}
         {ALTER TABLE $1 DROP CONSTRAINT IF EXISTS $2;\nALTER TABLE $1 ADD CONSTRAINT $2}gis;

  # CREATE TYPE has no IF NOT EXISTS; swallow duplicate_object instead.
  $c =~ s{(\bCREATE\s+TYPE\s+[^;]+;)}
         {DO \$idem\$ BEGIN $1 EXCEPTION WHEN duplicate_object THEN NULL; END \$idem\$;}gis;

  return $c;
}
