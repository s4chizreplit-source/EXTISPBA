import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface EmailRequest {
  to: string;
  userName: string;
  planType: 'monthly' | 'lifetime';
  status: 'approved' | 'rejected';
  adminNotes?: string;
}

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth check - admin only
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single();
    if (roleData?.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { to, userName, planType, status, adminNotes }: EmailRequest = await req.json();

    // Validate required fields
    if (!to || !userName || !planType || !status) {
      throw new Error("Missing required fields: to, userName, planType, status");
    }

    console.log(`Sending ${status} email to ${to} for ${planType} plan`);

    const planName = planType === 'monthly' ? 'Monthly Plan ($20/month)' : 'Lifetime Plan ($199)';
    
    let subject: string;
    let htmlContent: string;

    if (status === 'approved') {
      subject = `🎉 Your ${planType === 'monthly' ? 'Monthly' : 'Lifetime'} Subscription is Active!`;
      htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0a0a0a;">
          <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <div style="background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%); border-radius: 24px; padding: 40px; border: 1px solid #333;">
              
              <!-- Header -->
              <div style="text-align: center; margin-bottom: 32px;">
                <div style="width: 80px; height: 80px; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); border-radius: 20px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
                  <span style="font-size: 40px;">✓</span>
                </div>
                <h1 style="color: #ffffff; font-size: 28px; margin: 0 0 8px;">Subscription Activated!</h1>
                <p style="color: #888; font-size: 14px; margin: 0;">Your ${planName} is now active</p>
              </div>

              <!-- Greeting -->
              <p style="color: #ffffff; font-size: 16px; margin-bottom: 24px;">
                Hello <strong>${userName}</strong>,
              </p>

              <p style="color: #aaa; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
                Great news! Your subscription request has been <span style="color: #22c55e; font-weight: bold;">approved</span>. You now have full access to all platform features.
              </p>

              <!-- Plan Details Box -->
              <div style="background: #1f1f1f; border-radius: 16px; padding: 24px; margin-bottom: 24px; border: 1px solid #333;">
                <h3 style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px;">Your Plan</h3>
                <p style="color: #ffffff; font-size: 24px; font-weight: bold; margin: 0;">
                  ${planType === 'monthly' ? '📅 Monthly' : '👑 Lifetime'} Plan
                </p>
                ${planType === 'monthly' 
                  ? '<p style="color: #888; font-size: 12px; margin: 8px 0 0;">Valid for 30 days from activation</p>'
                  : '<p style="color: #888; font-size: 12px; margin: 8px 0 0;">Forever access - no renewal needed</p>'
                }
              </div>

              ${adminNotes ? `
              <div style="background: #1a2e1a; border-radius: 12px; padding: 16px; margin-bottom: 24px; border-left: 4px solid #22c55e;">
                <p style="color: #22c55e; font-size: 12px; font-weight: bold; margin: 0 0 8px;">Admin Note:</p>
                <p style="color: #aaa; font-size: 14px; margin: 0;">${adminNotes}</p>
              </div>
              ` : ''}

              <!-- CTA Button -->
              <div style="text-align: center; margin: 32px 0;">
                <a href="https://orgincwlaa.lovable.app/dashboard" style="display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: bold; font-size: 14px;">
                  Go to Dashboard →
                </a>
              </div>

              <!-- Footer -->
              <div style="border-top: 1px solid #333; padding-top: 24px; text-align: center;">
                <p style="color: #666; font-size: 12px; margin: 0;">
                  Need help? Reply to this email or contact support.
                </p>
              </div>

            </div>
          </div>
        </body>
        </html>
      `;
    } else {
      subject = `Update on Your Subscription Request`;
      htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0a0a0a;">
          <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <div style="background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%); border-radius: 24px; padding: 40px; border: 1px solid #333;">
              
              <!-- Header -->
              <div style="text-align: center; margin-bottom: 32px;">
                <div style="width: 80px; height: 80px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); border-radius: 20px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
                  <span style="font-size: 40px;">📋</span>
                </div>
                <h1 style="color: #ffffff; font-size: 28px; margin: 0 0 8px;">Request Update</h1>
                <p style="color: #888; font-size: 14px; margin: 0;">Regarding your ${planName} request</p>
              </div>

              <!-- Greeting -->
              <p style="color: #ffffff; font-size: 16px; margin-bottom: 24px;">
                Hello <strong>${userName}</strong>,
              </p>

              <p style="color: #aaa; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
                We have reviewed your subscription request. Unfortunately, we are unable to process it at this time.
              </p>

              ${adminNotes ? `
              <div style="background: #2e2a1a; border-radius: 12px; padding: 16px; margin-bottom: 24px; border-left: 4px solid #f59e0b;">
                <p style="color: #f59e0b; font-size: 12px; font-weight: bold; margin: 0 0 8px;">Reason:</p>
                <p style="color: #aaa; font-size: 14px; margin: 0;">${adminNotes}</p>
              </div>
              ` : ''}

              <p style="color: #aaa; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
                If you believe this is an error or have questions, please contact our support team.
              </p>

              <!-- Footer -->
              <div style="border-top: 1px solid #333; padding-top: 24px; text-align: center;">
                <p style="color: #666; font-size: 12px; margin: 0;">
                  Need help? Reply to this email or contact support.
                </p>
              </div>

            </div>
          </div>
        </body>
        </html>
      `;
    }

    const emailResponse = await resend.emails.send({
      from: "Subscription <noreply@resend.dev>",
      to: [to],
      subject: subject,
      html: htmlContent,
    });

    console.log("Subscription email sent successfully:", emailResponse);

    return new Response(JSON.stringify({ success: true, data: emailResponse }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in send-subscription-email function:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
