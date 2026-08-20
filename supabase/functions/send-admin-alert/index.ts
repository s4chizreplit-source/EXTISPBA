import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend@4.0.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// In-memory cooldown tracking (resets when function cold starts)
const lastAlertTimes: { [key: string]: number } = {}
const COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes cooldown

interface AlertPayload {
  job_name: string
  execution_id: string
  failed_count: number
  processed_count?: number
  skipped_count?: number
  completed_count?: number
  still_processing_count?: number
  test_mode?: boolean // For testing - sends to Resend account email only
  test_email?: string // Override recipient for testing
  error_details?: Array<{
    run_id?: string
    run_number?: number
    type?: string
    error?: string
  }>
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Auth check - only allow calls with valid auth (admin or service role from other edge functions)
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabaseAuth = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Verify token is valid (either user token or service role)
    const token = authHeader.replace('Bearer ', '')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    
    // Allow service role key (from cron/other edge functions) or valid user token
    if (token !== serviceKey && token !== anonKey) {
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token)
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    if (!resendApiKey) {
      console.error('RESEND_API_KEY not configured — skipping admin alert email')
      // Return 200 so the caller (cron job) does not treat this as a failure
      // and repeatedly re-trigger alerts. Admin must configure RESEND_API_KEY
      // to enable alert emails.
      return new Response(JSON.stringify({ skipped: true, reason: 'RESEND_API_KEY not configured' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const payload: AlertPayload = await req.json()
    console.log(`=== ADMIN ALERT REQUEST ===`)
    console.log(`Job: ${payload.job_name}`)
    console.log(`Execution ID: ${payload.execution_id}`)
    console.log(`Failed: ${payload.failed_count}`)

    // Check cooldown to prevent spam
    const cooldownKey = `${payload.job_name}`
    const lastAlert = lastAlertTimes[cooldownKey] || 0
    const now = Date.now()

    if (now - lastAlert < COOLDOWN_MS) {
      const remainingMs = COOLDOWN_MS - (now - lastAlert)
      console.log(`Cooldown active for ${payload.job_name}, ${Math.round(remainingMs / 1000)}s remaining`)
      return new Response(JSON.stringify({ 
        skipped: true, 
        reason: 'cooldown_active',
        remaining_seconds: Math.round(remainingMs / 1000)
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Get admin emails - use test email if in test mode
    let adminEmails: string[] = []
    
    if (payload.test_mode && payload.test_email) {
      // Test mode - use provided email
      adminEmails = [payload.test_email]
      console.log(`TEST MODE: Sending to ${payload.test_email}`)
    } else {
      // Production mode - fetch from database
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )

      const { data: adminUsers, error: adminError } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'admin')

      if (adminError || !adminUsers?.length) {
        console.error('Failed to fetch admin users:', adminError)
        return new Response(JSON.stringify({ error: 'No admins found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const adminUserIds = adminUsers.map(u => u.user_id)
      
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('email')
        .in('user_id', adminUserIds)

      if (profileError || !profiles?.length) {
        console.error('Failed to fetch admin emails:', profileError)
        return new Response(JSON.stringify({ error: 'No admin emails found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      adminEmails = profiles.map(p => p.email).filter(Boolean)
    }

    console.log(`Sending alert to ${adminEmails.length} recipient(s):`, adminEmails)

    // Build email content
    const timestamp = new Date().toISOString()
    const appUrl = Deno.env.get('SUPABASE_URL')?.replace('.supabase.co', '') || 'your-app'
    const cronMonitorUrl = `https://orgincwlaa.lovable.app/admin/cron-monitor`

    // Format error details
    let errorDetailsHtml = ''
    if (payload.error_details && payload.error_details.length > 0) {
      errorDetailsHtml = payload.error_details
        .slice(0, 10) // Limit to 10 errors
        .map((e, i) => `${i + 1}. Run #${e.run_number || 'N/A'} (${e.type || 'Unknown'}) - ${e.error || 'Unknown error'}`)
        .join('<br/>')
    }

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #111111;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #111111; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background-color: #1a1a1a; border-radius: 16px; border: 1px solid #333333; overflow: hidden;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 30px 40px; text-align: center; border-bottom: 1px solid #333333;">
              <div style="font-size: 56px; margin-bottom: 16px;">🚨</div>
              <h1 style="margin: 0 0 16px 0; font-size: 28px; font-weight: 700; color: #ef4444;">Cron Job Failure Alert</h1>
              <span style="display: inline-block; background-color: #ef4444; color: #ffffff; padding: 8px 20px; border-radius: 8px; font-weight: 600; font-size: 14px; letter-spacing: 0.5px;">${payload.job_name}</span>
            </td>
          </tr>
          
          <!-- Stats -->
          <tr>
            <td style="padding: 30px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="33%" style="text-align: center; padding: 20px 10px;">
                    <div style="font-size: 48px; font-weight: 800; color: #ef4444; line-height: 1;">${payload.failed_count}</div>
                    <div style="font-size: 13px; font-weight: 700; color: #ef4444; text-transform: uppercase; letter-spacing: 1px; margin-top: 8px;">Failed</div>
                  </td>
                  <td width="33%" style="text-align: center; padding: 20px 10px; border-left: 1px solid #333333; border-right: 1px solid #333333;">
                    <div style="font-size: 48px; font-weight: 800; color: #22c55e; line-height: 1;">${payload.processed_count ?? payload.completed_count ?? 0}</div>
                    <div style="font-size: 13px; font-weight: 700; color: #22c55e; text-transform: uppercase; letter-spacing: 1px; margin-top: 8px;">${payload.processed_count !== undefined ? 'Processed' : 'Completed'}</div>
                  </td>
                  <td width="33%" style="text-align: center; padding: 20px 10px;">
                    <div style="font-size: 48px; font-weight: 800; color: #f59e0b; line-height: 1;">${payload.skipped_count ?? payload.still_processing_count ?? 0}</div>
                    <div style="font-size: 13px; font-weight: 700; color: #f59e0b; text-transform: uppercase; letter-spacing: 1px; margin-top: 8px;">${payload.skipped_count !== undefined ? 'Skipped' : 'Processing'}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Execution Details -->
          <tr>
            <td style="padding: 0 40px 30px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0a0a0a; border-radius: 12px; border: 1px solid #2a2a2a;">
                <tr>
                  <td style="padding: 20px;">
                    <div style="font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 14px; color: #a0a0a0; line-height: 1.8;">
                      <span style="color: #666666;">Execution ID:</span> <span style="color: #ffffff;">${payload.execution_id}</span><br/>
                      <span style="color: #666666;">Time:</span> <span style="color: #ffffff;">${timestamp}</span>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          ${errorDetailsHtml ? `
          <!-- Failed Runs -->
          <tr>
            <td style="padding: 0 40px 30px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #1a0a0a; border-radius: 12px; border: 1px solid #ef4444;">
                <tr>
                  <td style="padding: 20px;">
                    <div style="font-size: 14px; font-weight: 700; color: #ef4444; margin-bottom: 12px;">❌ Failed Runs:</div>
                    <div style="font-size: 13px; color: #cccccc; line-height: 2;">
                      ${errorDetailsHtml}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ` : ''}
          
          <!-- CTA Button -->
          <tr>
            <td style="padding: 10px 40px 40px 40px; text-align: center;">
              <a href="${cronMonitorUrl}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; padding: 16px 40px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 15px; letter-spacing: 0.3px; box-shadow: 0 4px 14px rgba(59, 130, 246, 0.4);">View Cron Monitor →</a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; text-align: center; border-top: 1px solid #333333; background-color: #141414;">
              <p style="margin: 0; font-size: 12px; color: #666666; line-height: 1.6;">
                This is an automated alert from your engagement platform.<br/>
                Alerts are rate-limited (5 min cooldown) to prevent spam.
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `

    // Send email via Resend
    const resend = new Resend(resendApiKey)
    
    const { data: emailResult, error: emailError } = await resend.emails.send({
      from: 'Alerts <onboarding@resend.dev>', // Use resend.dev for testing, replace with verified domain
      to: adminEmails,
      subject: `⚠️ Cron Job Failure: ${payload.job_name} (${payload.failed_count} failed)`,
      html: emailHtml,
    })

    if (emailError) {
      console.error('Failed to send email:', emailError)
      return new Response(JSON.stringify({ error: 'Failed to send email', details: emailError }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Update cooldown
    lastAlertTimes[cooldownKey] = now
    console.log(`✅ Alert sent successfully! Email ID: ${emailResult?.id}`)

    return new Response(JSON.stringify({
      success: true,
      email_id: emailResult?.id,
      recipients: adminEmails.length,
      job_name: payload.job_name
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    console.error('Alert error:', error)
    return new Response(JSON.stringify({ 
      error: error.message || 'Internal server error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
