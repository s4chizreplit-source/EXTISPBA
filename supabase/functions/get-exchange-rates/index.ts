import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Cache rates for 1 hour in memory
let cachedRates: Record<string, number> | null = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

const SUPPORTED_CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'AED'];

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const now = Date.now();
    
    // Return cached rates if still valid
    if (cachedRates && (now - cacheTimestamp) < CACHE_DURATION) {
      return new Response(JSON.stringify({ 
        rates: cachedRates, 
        base: 'USD',
        cached: true,
        updated_at: new Date(cacheTimestamp).toISOString()
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch live rates from frankfurter.app (free, no API key needed)
    const targets = SUPPORTED_CURRENCIES.filter(c => c !== 'USD').join(',');
    const response = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${targets}`);
    
    if (!response.ok) {
      throw new Error(`Exchange rate API failed: ${response.status}`);
    }

    const data = await response.json();
    
    // Build rates object with USD as base = 1
    const rates: Record<string, number> = { USD: 1 };
    for (const [currency, rate] of Object.entries(data.rates)) {
      rates[currency] = rate as number;
    }

    // Cache the result
    cachedRates = rates;
    cacheTimestamp = now;

    return new Response(JSON.stringify({ 
      rates, 
      base: 'USD',
      cached: false,
      updated_at: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Exchange rate error:', error);
    
    // Fallback rates if API fails
    const fallbackRates: Record<string, number> = {
      USD: 1,
      INR: 83.5,
      EUR: 0.92,
      GBP: 0.79,
      AED: 3.67,
    };

    return new Response(JSON.stringify({ 
      rates: fallbackRates, 
      base: 'USD',
      cached: false,
      fallback: true,
      updated_at: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
