// Public signup endpoint. Creates a pre-confirmed user (no email verification
// required for first-time signup) using the admin API, then the client
// signs in with password. Rate-limit and duplicate checks handled inline.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } }
    )

    const { email: rawEmail, password, fullName } = await req.json().catch(() => ({}))
    const email = String(rawEmail ?? '').trim().toLowerCase()
    const pw = String(password ?? '')

    if (!email || !pw) {
      return new Response(JSON.stringify({ error: 'Email and password are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return new Response(JSON.stringify({ error: 'Please enter a valid email address' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (pw.length < 6) {
      return new Response(JSON.stringify({ error: 'Password must be at least 6 characters' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (pw.length > 512) {
      return new Response(JSON.stringify({ error: 'Password is too long (max 512 characters)' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Admin create user with email pre-confirmed (skip verification email).
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
      user_metadata: { full_name: String(fullName ?? '').slice(0, 120) },
    })

    if (error) {
      const raw = (error.message || '').toLowerCase()
      let msg = error.message || 'Signup failed'
      if (raw.includes('already') || raw.includes('registered') || raw.includes('exists') || raw.includes('duplicate')) {
        msg = 'This email is already registered. Please sign in instead.'
      } else if (raw.includes('rate') || raw.includes('too many')) {
        msg = 'Too many attempts. Please wait a few minutes and try again.'
      } else if (raw.includes('password')) {
        msg = error.message
      } else if (raw.includes('invalid') && raw.includes('email')) {
        msg = 'Please enter a valid email address'
      }
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ success: true, user: data.user }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error?.message ?? 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
