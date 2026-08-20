import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        return new Response(JSON.stringify({
            error: "Legacy Razorpay verify flow disabled. Use webhook-based credit only."
        }), {
            status: 410,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const supabaseAdmin = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
        const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");

        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
            return new Response(JSON.stringify({ error: "Razorpay keys not configured on server" }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // Get user from token
        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
        if (userError || !user) {
            return new Response(JSON.stringify({ error: "Invalid token" }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }
        const userId = user.id;

        const { paymentId, claimedUsdAmount } = await req.json();

        if (!paymentId || !paymentId.startsWith('pay_')) {
            return new Response(JSON.stringify({ error: "Invalid Payment ID format" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // 1. Check duplicate payment ID
        const { data: existing } = await supabaseAdmin
            .from("transactions")
            .select("id")
            .eq("payment_reference", paymentId)
            .maybeSingle();

        if (existing) {
            return new Response(JSON.stringify({ error: "Payment already processed" }), {
                status: 409,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // 2. Fetch payment details from Razorpay
        const auth = btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`);
        const rpResponse = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
            headers: { "Authorization": `Basic ${auth}` }
        });

        if (!rpResponse.ok) {
            return new Response(JSON.stringify({ error: "Could not verify payment with Razorpay" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const payment = await rpResponse.json();

        // 3. Verify status and amount
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
            return new Response(JSON.stringify({ error: `Payment status is ${payment.status}. It must be successful.` }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // 4. Get exchange rate (fetch or fallback)
        let exchangeRate = 83.5;
        try {
            const rateRes = await supabaseAdmin.functions.invoke('get-exchange-rates');
            if (rateRes.data?.rates?.INR) {
                exchangeRate = rateRes.data.rates.INR;
            }
        } catch (e) {
            console.error("Failed to fetch rates, using fallback 83.5", e);
        }

        const paidInr = payment.amount / 100; // Razorpay uses paisa
        const expectedInr = Number(claimedUsdAmount) * exchangeRate;

        // Tolerance check (allow 2% difference or $0.10)
        if (paidInr < (expectedInr * 0.98) - 1) {
            return new Response(JSON.stringify({
                error: `Amount mismatch. Paid ₹${paidInr}, expected ₹${expectedInr.toFixed(2)}.`
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const actualUsd = paidInr / exchangeRate;

        // 5. Update wallet
        const { data: wallet } = await supabaseAdmin
            .from("wallets")
            .select("balance, total_deposited")
            .eq("user_id", userId)
            .single();

        const newBalance = (Number(wallet?.balance || 0) + actualUsd);
        const newTotal = (Number(wallet?.total_deposited || 0) + actualUsd);

        const { error: updateErr } = await supabaseAdmin
            .from("wallets")
            .update({
                balance: newBalance,
                total_deposited: newTotal,
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);

        if (updateErr) throw updateErr;

        // 6. Record transaction
        const { error: txErr } = await supabaseAdmin.from("transactions").insert({
            user_id: userId,
            type: "deposit",
            amount: actualUsd,
            balance_after: newBalance,
            status: "completed",
            payment_method: "razorpay",
            payment_reference: paymentId,
            description: `Razorpay Deposit — ₹${paidInr} via ${payment.method}`,
        });

        if (txErr) throw txErr;

        // 7. Notify Admin
        try {
            await supabaseAdmin.functions.invoke('send-telegram-notification', {
                body: {
                    message: `<b>✅ AUTO DEPOSIT SUCCESS</b>\n\n` +
                        `👤 <b>User:</b> ${user.email}\n` +
                        `💰 <b>Amount:</b> $${actualUsd.toFixed(2)} (₹${paidInr})\n` +
                        `💳 <b>Method:</b> ${payment.method}\n` +
                        `🆔 <b>Ref:</b> <code>${paymentId}</code>`
                }
            });
        } catch (e) {
            console.error("Failed to send telegram notification", e);
        }

        return new Response(JSON.stringify({
            success: true,
            amount: actualUsd,
            message: `Successfully credited $${actualUsd.toFixed(2)}`
        }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

    } catch (err: any) {
        console.error("verify-razorpay-deposit error:", err);
        return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
