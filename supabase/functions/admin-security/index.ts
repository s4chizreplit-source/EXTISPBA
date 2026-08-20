import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify the caller is admin
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check admin role
    const { data: roleData } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: "Not admin" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action, newPassword } = await req.json();

    if (action === "change-password") {
      if (!newPassword || newPassword.length < 12) {
        return new Response(JSON.stringify({ error: "Password must be at least 12 characters" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
        password: newPassword,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ success: true, message: "Password changed successfully" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "logout-all-users") {
      // Get all users and sign them out
      const { data: users } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
      
      let loggedOut = 0;
      if (users?.users) {
        for (const u of users.users) {
          try {
            await supabaseAdmin.auth.admin.signOut(u.id, 'global');
            loggedOut++;
          } catch (e) {
            console.error(`Failed to logout user ${u.id}:`, e);
          }
        }
      }

      return new Response(JSON.stringify({ success: true, message: `Logged out ${loggedOut} users` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "check-fake-admins") {
      const { data: admins } = await supabaseAdmin
        .from("user_roles")
        .select("user_id, role, created_at")
        .eq("role", "admin");

      const adminDetails = [];
      if (admins) {
        for (const admin of admins) {
          const { data: profile } = await supabaseAdmin
            .from("profiles")
            .select("email, full_name")
            .eq("user_id", admin.user_id)
            .single();
          adminDetails.push({ ...admin, email: profile?.email, full_name: profile?.full_name });
        }
      }

      return new Response(JSON.stringify({ admins: adminDetails }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
