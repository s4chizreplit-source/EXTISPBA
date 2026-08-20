import { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
    Key,
    Copy,
    RefreshCw,
    Eye,
    EyeOff,
    Code2,
    CheckCircle2,
    Globe,
    ShoppingCart,
    Wallet,
    ListOrdered,
    ChevronRight,
    Zap,
    Shield,
    AlertCircle,
} from 'lucide-react';

// Detect Supabase project URL for showing API base URL
const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL || 'https://YOUR_PROJECT.supabase.co';
const API_BASE = `${SUPABASE_URL}/functions/v1/public-api`;

function generateApiKey(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(48);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => chars[b % chars.length]).join('');
}

export default function ApiAccess() {
    const { user, profile, refreshProfile } = useAuth();
    const [isGenerating, setIsGenerating] = useState(false);
    const [showKey, setShowKey] = useState(false);
    const [copied, setCopied] = useState(false);

    const apiKey: string | null = (profile as any)?.api_key ?? null;

    const handleGenerateKey = async () => {
        if (!user) return;
        setIsGenerating(true);
        try {
            const newKey = generateApiKey();
            const { error } = await supabase
                .from('profiles')
                .update({ api_key: newKey })
                .eq('user_id', user.id);

            if (error) throw error;
            await refreshProfile();
            toast.success('API Key generated successfully!');
            setShowKey(true);
        } catch (err: any) {
            toast.error(err.message || 'Failed to generate API key');
        } finally {
            setIsGenerating(false);
        }
    };

    const handleCopy = async (text: string) => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        toast.success('Copied to clipboard!');
        setTimeout(() => setCopied(false), 2000);
    };

    const maskedKey = apiKey
        ? apiKey.slice(0, 8) + '••••••••••••••••••••••••••••••••' + apiKey.slice(-6)
        : null;

    return (
        <DashboardLayout>
            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6 pb-10">
                {/* Header */}
                <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-primary/80 via-zinc-900 to-zinc-950 border border-white/[0.07] p-6 sm:p-8">
                    <div className="relative z-10 flex items-start gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary flex items-center justify-center shadow-lg shrink-0">
                            <Code2 className="h-7 w-7 text-white" />
                        </div>
                        <div>
                            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">API Access</h1>
                            <p className="text-sm text-zinc-200 mt-1 max-w-xl">
                                Apna API key generate karein aur ise apne panel mein use karein — same services, same rates.
                            </p>
                        </div>
                    </div>
                    <div className="absolute top-0 right-0 w-56 h-56 bg-primary/10 rounded-full blur-3xl -translate-y-1/3 translate-x-1/4" />
                </div>

                {/* API Key Card */}
                <div className="rounded-2xl bg-zinc-950 border border-white/[0.07] p-6 space-y-5">
                    <div className="flex items-center gap-2">
                        <Key className="h-4 w-4 text-primary" />
                        <h2 className="text-base font-semibold text-white">Your API Key</h2>
                    </div>

                    {apiKey ? (
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 p-4 rounded-xl bg-zinc-900 border border-white/[0.05] group">
                                <code className="flex-1 text-[13px] font-mono text-primary truncate select-all">
                                    {showKey ? apiKey : maskedKey}
                                </code>
                                <button
                                    onClick={() => setShowKey(!showKey)}
                                    className="shrink-0 text-zinc-500 hover:text-zinc-100 transition-colors p-1.5 rounded-lg hover:bg-card"
                                    title={showKey ? 'Hide key' : 'Show key'}
                                >
                                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </button>
                                <button
                                    onClick={() => handleCopy(apiKey)}
                                    className="shrink-0 text-zinc-500 hover:text-primary transition-colors p-1.5 rounded-lg hover:bg-primary/10"
                                    title="Copy"
                                >
                                    {copied ? <CheckCircle2 className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                                </button>
                            </div>

                            <div className="flex items-center gap-2 text-xs text-zinc-500 px-1">
                                <Shield className="h-3.5 w-3.5 text-amber-500/80" />
                                <span>Yeh key secret rakhein. Kisi ke saath share mat karein.</span>
                            </div>

                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleGenerateKey}
                                disabled={isGenerating}
                                className="text-zinc-200 border-white/[0.07] hover:text-foreground hover:bg-card hover:border-white/[0.12]"
                            >
                                {isGenerating ? (
                                    <RefreshCw className="h-3.5 w-3.5 mr-2 animate-spin" />
                                ) : (
                                    <RefreshCw className="h-3.5 w-3.5 mr-2" />
                                )}
                                Regenerate Key
                            </Button>
                        </div>
                    ) : (
                        <div className="text-center py-10 space-y-4">
                            <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-white/[0.05] flex items-center justify-center mx-auto">
                                <Key className="h-7 w-7 text-zinc-600" />
                            </div>
                            <div>
                                <p className="text-white font-medium">Abhi tak koi API Key nahi hai</p>
                                <p className="text-sm text-zinc-500 mt-1">Neeche button se generate karein</p>
                            </div>
                            <Button
                                onClick={handleGenerateKey}
                                disabled={isGenerating}
                                className="bg-primary hover:bg-primary text-white shadow-lg shadow-violet-600/20"
                            >
                                {isGenerating ? (
                                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                                ) : (
                                    <Zap className="h-4 w-4 mr-2" />
                                )}
                                Generate API Key
                            </Button>
                        </div>
                    )}
                </div>

                {/* API Base URL */}
                <div className="rounded-2xl bg-zinc-950 border border-white/[0.07] p-6 space-y-4">
                    <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-sky-400" />
                        <h2 className="text-base font-semibold text-white">API Base URL</h2>
                    </div>
                    <div className="flex items-center gap-2 p-4 rounded-xl bg-zinc-900 border border-white/[0.05]">
                        <code className="flex-1 text-[13px] font-mono text-sky-300 break-all">{API_BASE}</code>
                        <button
                            onClick={() => handleCopy(API_BASE)}
                            className="shrink-0 text-zinc-500 hover:text-sky-400 transition-colors p-1.5 rounded-lg hover:bg-sky-500/10"
                        >
                            <Copy className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* API Documentation */}
                <div className="rounded-2xl bg-zinc-950 border border-white/[0.07] p-6 space-y-6">
                    <div className="flex items-center gap-2">
                        <ListOrdered className="h-4 w-4 text-emerald-400" />
                        <h2 className="text-base font-semibold text-white">API Endpoints</h2>
                    </div>

                    {/* Notice */}
                    <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
                        <AlertCircle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                        <p className="text-xs text-amber-200/70">
                            Saare requests ko <code className="bg-amber-500/10 px-1 py-0.5 rounded text-amber-300">POST</code> method se bhejein aur body mein <code className="bg-amber-500/10 px-1 py-0.5 rounded text-amber-300">key</code> field zaroori hai.
                        </p>
                    </div>

                    <div className="space-y-4">
                        {/* services */}
                        <EndpointCard
                            icon={<ListOrdered className="h-4 w-4 text-emerald-400" />}
                            method="POST"
                            action="services"
                            label="Services List"
                            description="Sare available services aur unke rates dekkhein"
                            request={`{\n  "key": "YOUR_API_KEY",\n  "action": "services"\n}`}
                            response={`{\n  "status": "ok",\n  "services": [\n    {\n      "service": 1001,\n      "name": "Instagram Followers",\n      "category": "Instagram",\n      "rate": "0.50",\n      "min": 100,\n      "max": 50000\n    }\n  ]\n}`}
                            onCopyRequest={() =>
                                handleCopy(`{\n  "key": "${apiKey || 'YOUR_API_KEY'}",\n  "action": "services"\n}`)
                            }
                        />

                        {/* add */}
                        <EndpointCard
                            icon={<ShoppingCart className="h-4 w-4 text-primary" />}
                            method="POST"
                            action="add"
                            label="Place Order"
                            description="Naya order place karein (wallet se amount deduct hoga)"
                            request={`{\n  "key": "YOUR_API_KEY",\n  "action": "add",\n  "service": 1001,\n  "link": "https://instagram.com/p/...",\n  "quantity": 1000\n}`}
                            response={`{\n  "status": "ok",\n  "order": 78432\n}`}
                            onCopyRequest={() =>
                                handleCopy(
                                    `{\n  "key": "${apiKey || 'YOUR_API_KEY'}",\n  "action": "add",\n  "service": 1001,\n  "link": "https://instagram.com/p/...",\n  "quantity": 1000\n}`
                                )
                            }
                        />

                        {/* status */}
                        <EndpointCard
                            icon={<ChevronRight className="h-4 w-4 text-sky-400" />}
                            method="POST"
                            action="status"
                            label="Order Status"
                            description="Kisi bhi order ka status check karein"
                            request={`{\n  "key": "YOUR_API_KEY",\n  "action": "status",\n  "order": 78432\n}`}
                            response={`{\n  "status": "ok",\n  "order": {\n    "order_number": 78432,\n    "status": "processing",\n    "quantity": 1000,\n    "remains": 250,\n    "service": "Instagram Followers"\n  }\n}`}
                            onCopyRequest={() =>
                                handleCopy(
                                    `{\n  "key": "${apiKey || 'YOUR_API_KEY'}",\n  "action": "status",\n  "order": 78432\n}`
                                )
                            }
                        />

                        {/* balance */}
                        <EndpointCard
                            icon={<Wallet className="h-4 w-4 text-amber-400" />}
                            method="POST"
                            action="balance"
                            label="Check Balance"
                            description="Apna wallet balance check karein"
                            request={`{\n  "key": "YOUR_API_KEY",\n  "action": "balance"\n}`}
                            response={`{\n  "status": "ok",\n  "balance": "2120.90",\n  "currency": "INR"\n}`}
                            onCopyRequest={() =>
                                handleCopy(`{\n  "key": "${apiKey || 'YOUR_API_KEY'}",\n  "action": "balance"\n}`)
                            }
                        />
                    </div>
                </div>
            </div>
        </DashboardLayout>
    );
}

// --- Helper Component ---

interface EndpointCardProps {
    icon: React.ReactNode;
    method: string;
    action: string;
    label: string;
    description: string;
    request: string;
    response: string;
    onCopyRequest: () => void;
}

function EndpointCard({
    icon,
    action,
    label,
    description,
    request,
    response,
    onCopyRequest,
}: EndpointCardProps) {
    const [tab, setTab] = useState<'request' | 'response'>('request');

    return (
        <div className="rounded-xl border border-white/[0.06] overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-3 bg-zinc-900/60">
                <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-card">
                    {icon}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-white">{label}</p>
                    <p className="text-[11px] text-zinc-500">{description}</p>
                </div>
                <span className="text-[10px] font-mono bg-zinc-800 text-zinc-200 px-2 py-1 rounded-md border border-white/[0.05]">
                    action: "{action}"
                </span>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/[0.05] bg-zinc-950">
                <button
                    onClick={() => setTab('request')}
                    className={`flex-1 py-2 text-[12px] font-medium transition-colors ${tab === 'request' ? 'text-white border-b-2 border-primary bg-primary/5' : 'text-zinc-600 hover:text-zinc-200'
                        }`}
                >
                    Request
                </button>
                <button
                    onClick={() => setTab('response')}
                    className={`flex-1 py-2 text-[12px] font-medium transition-colors ${tab === 'response' ? 'text-white border-b-2 border-emerald-500 bg-emerald-500/5' : 'text-zinc-600 hover:text-zinc-200'
                        }`}
                >
                    Response
                </button>
            </div>

            {/* Code block */}
            <div className="relative bg-[#ffffff] p-4 group">
                <pre className="text-[12px] font-mono text-zinc-100 whitespace-pre overflow-x-auto">
                    {tab === 'request' ? request : response}
                </pre>
                {tab === 'request' && (
                    <button
                        onClick={onCopyRequest}
                        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity text-zinc-600 hover:text-zinc-100 p-1.5 rounded-lg hover:bg-card"
                    >
                        <Copy className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
        </div>
    );
}
