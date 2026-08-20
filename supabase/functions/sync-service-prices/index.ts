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

    // Verify admin OR service role
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Not authenticated");
    const token = authHeader.replace("Bearer ", "");
    
    // Bypass for cron/system calls
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const isSystemCall = (token === serviceRoleKey) || (anonKey && token === anonKey);

    if (!isSystemCall) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) throw new Error("Not authenticated");

      const { data: roleData } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      if (!roleData) throw new Error("Admin access required");
    }

    // Optional: sync only specific service IDs
    const body = await req.json().catch(() => ({}));
    const targetServiceIds: string[] | null = body.service_ids || null;

    // Get all service_provider_mappings with provider account details
    let mappingQuery = supabase
      .from("service_provider_mapping")
      .select("service_id, provider_service_id, provider_account_id, provider_accounts!inner(api_url, api_key, name)")
      .eq("is_active", true);

    if (targetServiceIds && targetServiceIds.length > 0) {
      mappingQuery = mappingQuery.in("service_id", targetServiceIds);
    }

    const { data: mappings, error: mapError } = await mappingQuery;
    if (mapError) throw mapError;
    if (!mappings || mappings.length === 0) {
      return new Response(JSON.stringify({ message: "No mappings found", updated: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Group mappings by service_id
    const serviceMap: Record<string, Array<{
      providerServiceId: string;
      apiUrl: string;
      apiKey: string;
      accountName: string;
    }>> = {};

    for (const m of mappings) {
      const sid = m.service_id;
      if (!sid) continue;
      const account = (m as any).provider_accounts;
      if (!account) continue;

      if (!serviceMap[sid]) serviceMap[sid] = [];
      serviceMap[sid].push({
        providerServiceId: m.provider_service_id,
        apiUrl: account.api_url,
        apiKey: account.api_key,
        accountName: account.name,
      });
    }

    const results: Array<{ serviceId: string; oldPrice: number; newPrice: number; source: string }> = [];
    const errors: Array<{ serviceId: string; error: string }> = [];

    // Get current prices for all services we'll update
    const serviceIds = Object.keys(serviceMap);
    const { data: currentServices } = await supabase
      .from("services")
      .select("id, price, name")
      .in("id", serviceIds);
    const currentPriceMap: Record<string, { price: number; name: string }> = {};
    (currentServices || []).forEach(s => { currentPriceMap[s.id] = { price: s.price, name: s.name }; });

    // 1. Fetch exchange rates
    let exchangeRates: Record<string, number> = { USD: 1, INR: 83.5, EUR: 0.92, GBP: 0.79, AED: 3.67 };
    try {
      const extReq = await fetch(`${supabaseUrl}/functions/v1/get-exchange-rates`);
      if (extReq.ok) {
        const ratesData = await extReq.json();
        if (ratesData.rates) exchangeRates = ratesData.rates;
      }
    } catch (e) {
      console.error("Failed to fetch exchange rates, using fallbacks:", e);
    }

    // 2. Fetch unique provider currencies
    const uniqueProviders: Array<any> = [];
    const providerMapByName = new Map();
    for (const mappings of Object.values(serviceMap)) {
      for (const p of mappings) {
        if (!providerMapByName.has(p.accountName)) {
          providerMapByName.set(p.accountName, p);
          uniqueProviders.push(p);
        }
      }
    }

    const providerCurrencyCache: Record<string, string> = {};

    // TARGET_CURRENCY for the Database is now ALWAYS USD to match wallet balances.
    const TARGET_CURRENCY = 'USD';
    const DEFAULT_PROVIDER_CURRENCY = Deno.env.get("PROVIDER_CURRENCY") || 'INR';

    for (const p of uniqueProviders) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${p.apiUrl}?key=${p.apiKey}&action=balance`, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          providerCurrencyCache[p.accountName] = data.currency || DEFAULT_PROVIDER_CURRENCY;
          console.log(`[CURRENCY] Provider ${p.accountName} currency detected as ${providerCurrencyCache[p.accountName]}`);
        } else {
          providerCurrencyCache[p.accountName] = DEFAULT_PROVIDER_CURRENCY;
        }
      } catch (e) {
        providerCurrencyCache[p.accountName] = DEFAULT_PROVIDER_CURRENCY;
      }
    }

    function convertToTarget(amount: number, fromCurrency?: string): number {
      const fromUpper = (fromCurrency || DEFAULT_PROVIDER_CURRENCY).toUpperCase();
      const targetUpper = TARGET_CURRENCY.toUpperCase();
      if (fromUpper === targetUpper) return amount;

      const fromRate = exchangeRates[fromUpper] || (fromUpper === 'INR' ? 83.5 : 1);
      const targetRate = exchangeRates[targetUpper] || 1;

      const amountUsd = amount / fromRate;
      const amountTarget = amountUsd * targetRate;
      // Round to 5 decimals for precision (because USD prices can be very small)
      return Number(amountTarget.toFixed(5));
    }

    // NOTE: Markup is NOT applied here. Database stores RAW provider cost.
    // Markup is applied DYNAMICALLY by the frontend & API using platform_settings.global_markup_percent.
    // This way, admin can change markup % and it instantly reflects everywhere without re-syncing.

    // For each service, query all mapped providers and find highest rate
    for (const [serviceId, providers] of Object.entries(serviceMap)) {
      let highestRate = 0;
      let highestSource = "";

      // Query each provider in parallel
      const ratePromises = providers.map(async (p) => {
        try {
          const url = `${p.apiUrl}?key=${p.apiKey}&action=services&service=${p.providerServiceId}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);

          if (!response.ok) return null;

          const data = await response.json();

          // API can return array of services or single object
          let rate = 0;
          if (Array.isArray(data)) {
            // Find the exact service in the array
            const found = data.find((s: any) => String(s.service) === String(p.providerServiceId));
            if (found) rate = parseFloat(found.rate) || 0;
          } else if (data && data.rate) {
            rate = parseFloat(data.rate) || 0;
          }

          // Convert the fetched rate to the TARGET DB Currency (USD)
          const rawCurrency = providerCurrencyCache[p.accountName] || "USD";
          const convertedRate = convertToTarget(rate, rawCurrency);

          console.log(`[RATE] ${p.accountName} service=${p.providerServiceId} raw=${rate} ${rawCurrency} -> converted=${convertedRate} ${TARGET_CURRENCY}`);
          return { rate: convertedRate, source: p.accountName, providerServiceId: p.providerServiceId };
        } catch (e) {
          console.error(`Error fetching rate from ${p.accountName} for service ${p.providerServiceId}:`, e);
          return null;
        }
      });

      const rateResults = await Promise.all(ratePromises);

      for (const r of rateResults) {
        if (r && r.rate > highestRate) {
          highestRate = r.rate;
          highestSource = `${r.source} (${r.providerServiceId})`;
        }
      }

      if (highestRate > 0) {
        const oldPrice = currentPriceMap[serviceId]?.price ?? 0;

        // Store RAW provider cost (no markup). Frontend applies markup dynamically.
        const rawCost = Number(highestRate.toFixed(5));

        console.log(`[UPDATE] service=${serviceId} name="${currentPriceMap[serviceId]?.name}" rawCost=${rawCost} from=${highestSource}`);

        // Update service price to RAW provider cost
        const { error: updateError } = await supabase
          .from("services")
          .update({ 
            price: rawCost,
            updated_at: new Date().toISOString()
          })
          .eq("id", serviceId);

        if (updateError) {
          errors.push({ serviceId, error: updateError.message });
        } else {
          results.push({
            serviceId,
            oldPrice,
            newPrice: rawCost,
            source: highestSource,
          });
        }
      } else {
        errors.push({ serviceId, error: "No valid rate found from any provider" });
      }
    }

    return new Response(JSON.stringify({
      message: `Synced ${results.length} service prices (raw provider costs). Markup applied dynamically by frontend.`,
      updated: results.length,
      results,
      errors: errors.length > 0 ? errors : undefined,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("sync-service-prices error:", error);
      return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
