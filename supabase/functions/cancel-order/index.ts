import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        const supabase = createClient(supabaseUrl, serviceRoleKey);

        // Verify authentication
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) throw new Error("Not authenticated");
        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) throw new Error("Not authenticated");

        // Check if user is admin
        const { data: roleData } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", user.id)
            .eq("role", "admin")
            .maybeSingle();

        const isAdmin = !!roleData;

        const body = await req.json().catch(() => ({}));
        const orderId = body.order_id;
        if (!orderId) throw new Error("No order_id provided");

        // Fetch the order
        const { data: order, error: orderError } = await supabase
            .from("orders")
            .select("*")
            .eq("id", orderId)
            .single();

        if (orderError || !order) {
            throw new Error("Order not found");
        }

        // Only admin can cancel ANY order. Users can only cancel their OWN orders.
        if (!isAdmin && order.user_id !== user.id) {
            throw new Error("Not authorized to cancel this order");
        }

        if (order.status === 'cancelled') {
            throw new Error("Order is already cancelled");
        }

        let refundAmount = 0;
        let refundedQuantity = 0;

        if (order.is_organic_mode) {
            // Find pending runs and cancel them. No refund is issued to anyone.
            const { data: pendingRuns, error: runsError } = await supabase
                .from('organic_run_schedule')
                .select('id, quantity_to_send')
                .eq('order_id', orderId)
                .eq('status', 'pending');

            if (runsError) throw new Error("Error fetching runs: " + runsError.message);

            if (pendingRuns && pendingRuns.length > 0) {
                const runIds = pendingRuns.map((r: any) => r.id);
                const { error: updateRunsError } = await supabase
                    .from('organic_run_schedule')
                    .update({ status: 'cancelled' })
                    .in('id', runIds);

                if (updateRunsError) throw new Error("Failed to update runs: " + updateRunsError.message);

                console.log(`Cancelled ${pendingRuns.length} pending runs for order ${orderId}. No refund issued.`);
            }
        }
        // Normal (non-organic) orders: no refund either.

        // Update order status
        const { error: updateOrderError } = await supabase
            .from('orders')
            .update({ status: 'cancelled' })
            .eq('id', orderId);

        if (updateOrderError) throw new Error("Failed to update order: " + updateOrderError.message);

        // Process refund
        if (refundAmount > 0) {
            // Get current wallet
            const { data: wallet } = await supabase
                .from('wallets')
                .select('balance, total_spent')
                .eq('user_id', order.user_id)
                .single();

            if (wallet) {
                const { error: walletError } = await supabase
                    .from('wallets')
                    .update({
                        balance: wallet.balance + refundAmount,
                        total_spent: wallet.total_spent - refundAmount // Un-spend it
                    })
                    .eq('user_id', order.user_id);

                if (walletError) throw new Error("Failed to refund wallet: " + walletError.message);

                // Create transaction record
                await supabase.from('transactions').insert({
                    user_id: order.user_id,
                    type: 'refund',
                    amount: refundAmount,
                    balance_after: wallet.balance + refundAmount,
                    description: `Refund for cancelled order #${order.order_number}`,
                    status: 'completed'
                });
            }
        }

        return new Response(JSON.stringify({
            success: true,
            message: 'Order cancelled successfully',
            refundAmount,
            refundedQuantity
        }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

    } catch (err: any) {
        console.error("Cancel order error:", err);
        return new Response(JSON.stringify({ error: err.message || "Failed to cancel order" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400,
        });
    }
});
