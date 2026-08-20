// Placeholder function so Supabase recognises the folder. Tests live in
// index.test.ts and hit PostgREST/RPC directly — they don't invoke this handler.
Deno.serve(() =>
  new Response(
    JSON.stringify({
      ok: true,
      note: "This folder hosts payment-security Deno tests. Run the test suite instead of calling this function.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
);
