import { useEffect, lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { AdminGuard } from "@/components/admin/AdminGuard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { CurrencyProvider } from "@/hooks/useCurrency";
import { ScrollToTop } from "@/components/ScrollToTop";
import { toast } from "sonner";
import { AppErrorBoundary } from "@/components/app/AppErrorBoundary";

// Route-level chunks keep the initial download small under heavy traffic.
// Frequently-used routes are still warmed during browser idle time below.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const EngagementOrder = lazy(() => import("./pages/EngagementOrder"));
const EngagementOrders = lazy(() => import("./pages/EngagementOrders"));
const Orders = lazy(() => import("./pages/Orders"));
const Wallet = lazy(() => import("./pages/Wallet"));

// Lazy — landing, auth, secondary, legal, all admin pages
const Index = lazy(() => import("./pages/Index"));
const Auth = lazy(() => import("./pages/Auth"));

const NotFound = lazy(() => import("./pages/NotFound"));
const Services = lazy(() => import("./pages/Services"));

const Settings = lazy(() => import("./pages/Settings"));
const Support = lazy(() => import("./pages/Support"));
const ApiAccess = lazy(() => import("./pages/ApiAccess"));
const EngagementOrderDetail = lazy(() => import("./pages/EngagementOrderDetail"));
const MassOrder = lazy(() => import("./pages/MassOrder"));
const InstagramPage = lazy(() => import("./pages/Instagram"));
const MyPosts = lazy(() => import("./pages/MyPosts"));
const TelegramBot = lazy(() => import("./pages/TelegramBot"));

const Admin = lazy(() => import("./pages/admin/Admin"));
const AdminServices = lazy(() => import("./pages/admin/AdminServices"));
const AdminUsers = lazy(() => import("./pages/admin/AdminUsers"));
const AdminOrders = lazy(() => import("./pages/admin/AdminOrders"));
const AdminBundles = lazy(() => import("./pages/admin/AdminBundles"));
const AdminCronMonitor = lazy(() => import("./pages/admin/AdminCronMonitor"));
const AdminChat = lazy(() => import("./pages/admin/AdminChat"));
const AdminDeposits = lazy(() => import("./pages/admin/AdminDeposits"));
const AdminProviderAccounts = lazy(() => import("./pages/admin/AdminProviderAccounts"));
const AdminServiceProviderMapping = lazy(() => import("./pages/admin/AdminServiceProviderMapping"));
const AdminTopupPlan = lazy(() => import("./pages/admin/AdminTopupPlan"));
const AdminOxapayLog = lazy(() => import("./pages/admin/AdminOxapayLog"));
const AdminSecurityAudit = lazy(() => import("./pages/admin/AdminSecurityAudit"));
const AdminWebhookEvents = lazy(() => import("./pages/admin/AdminWebhookEvents"));

const TermsOfService = lazy(() => import("./pages/legal/TermsOfService"));
const PrivacyPolicy = lazy(() => import("./pages/legal/PrivacyPolicy"));
const RefundPolicy = lazy(() => import("./pages/legal/RefundPolicy"));
const CookiePolicy = lazy(() => import("./pages/legal/CookiePolicy"));
const ContactUs = lazy(() => import("./pages/legal/ContactUs"));
const AboutUs = lazy(() => import("./pages/legal/AboutUs"));
const ShippingPolicy = lazy(() => import("./pages/legal/ShippingPolicy"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10 * 60 * 1000,      // 10 min — use cache, don't refetch
      gcTime: 30 * 60 * 1000,          // 30 min cache retention
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      refetchIntervalInBackground: false, // don't hammer server from background tabs
      networkMode: "online",
      retry: 2,
      retryDelay: (i) => Math.min(1000 * 2 ** i, 10000),
    },
    mutations: {
      retry: 1,
      retryDelay: 1000,
      networkMode: "online",
    },
  },
});


const App = () => {
  useEffect(() => {
    const handleRejection = (e: PromiseRejectionEvent) => {
      console.error("Unhandled rejection:", e.reason);
      toast.error("An error occurred. Please try again.");
      e.preventDefault();
    };
    const handleError = (e: ErrorEvent) => {
      console.error("Unhandled error:", e.error || e.message);
    };
    window.addEventListener("unhandledrejection", handleRejection);
    window.addEventListener("error", handleError);

    // Warm up heavy lazy routes during browser idle time so the first
    // navigation feels instant. Failures are ignored — this is best-effort.
    const idle = (cb: () => void) => {
      const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number };
      if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(cb);
      else setTimeout(cb, 1500);
    };
    idle(() => {
      import("./pages/Dashboard").catch(() => {});
      import("./pages/EngagementOrder").catch(() => {});
      import("./pages/EngagementOrders").catch(() => {});
      import("./pages/Orders").catch(() => {});
      import("./pages/Wallet").catch(() => {});
      import("./pages/Services").catch(() => {});
      import("./pages/Settings").catch(() => {});
      import("./pages/EngagementOrderDetail").catch(() => {});
      import("./pages/MyPosts").catch(() => {});
      import("./pages/Instagram").catch(() => {});
    });

    return () => {
      window.removeEventListener("unhandledrejection", handleRejection);
      window.removeEventListener("error", handleError);
    };
  }, []);


  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <CurrencyProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <AppErrorBoundary>
              <BrowserRouter>
                <ScrollToTop />
                <Suspense fallback={
                  <div className="min-h-screen flex items-center justify-center bg-background">
                    <div className="w-10 h-10 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                  </div>
                }>

                  <Routes>
                    {/* User pages */}
                    <Route path="/" element={<Index />} />
                    <Route path="*" element={<NotFound />} />
                    <Route path="/auth" element={<Auth />} />
                    
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/services" element={<Services />} />
                    <Route path="/order" element={<Navigate to="/engagement-order" replace />} />
                    <Route path="/orders" element={<Orders />} />
                    <Route path="/wallet" element={<Wallet />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/support" element={<Support />} />
                    <Route path="/api-access" element={<ApiAccess />} />

                    {/* Engagement */}
                    <Route path="/engagement-order" element={<EngagementOrder />} />
                    <Route path="/engagement-orders" element={<EngagementOrders />} />
                    <Route path="/engagement-orders/:orderNumber" element={<EngagementOrderDetail />} />
                    <Route path="/mass-order" element={<MassOrder />} />
                    <Route path="/instagram" element={<InstagramPage />} />
                    <Route path="/my-posts" element={<MyPosts />} />
                    <Route path="/telegram-bot" element={<TelegramBot />} />

                    {/* Admin — server-verified guard */}
                    <Route path="/admin" element={<AdminGuard><Admin /></AdminGuard>} />
                    <Route path="/admin/services" element={<AdminGuard><AdminServices /></AdminGuard>} />
                    <Route path="/admin/users" element={<AdminGuard><AdminUsers /></AdminGuard>} />
                    <Route path="/admin/orders" element={<AdminGuard><AdminOrders /></AdminGuard>} />
                    <Route path="/admin/bundles" element={<AdminGuard><AdminBundles /></AdminGuard>} />
                    <Route path="/admin/cron-monitor" element={<AdminGuard><AdminCronMonitor /></AdminGuard>} />
                    <Route path="/admin/chat" element={<AdminGuard><AdminChat /></AdminGuard>} />
                    <Route path="/admin/deposits" element={<AdminGuard><AdminDeposits /></AdminGuard>} />
                    <Route path="/admin/provider-accounts" element={<AdminGuard><AdminProviderAccounts /></AdminGuard>} />
                    <Route path="/admin/service-provider-mapping" element={<AdminGuard><AdminServiceProviderMapping /></AdminGuard>} />
                    <Route path="/admin/topup-plan" element={<AdminGuard><AdminTopupPlan /></AdminGuard>} />
                    <Route path="/admin/oxapay-log" element={<AdminGuard><AdminOxapayLog /></AdminGuard>} />
                    <Route path="/admin/security-audit" element={<AdminGuard><AdminSecurityAudit /></AdminGuard>} />
                    <Route path="/admin/webhook-events" element={<AdminGuard><AdminWebhookEvents /></AdminGuard>} />

                    {/* Legal */}
                    <Route path="/terms" element={<TermsOfService />} />
                    <Route path="/privacy" element={<PrivacyPolicy />} />
                    <Route path="/refund" element={<RefundPolicy />} />
                    <Route path="/cookies" element={<CookiePolicy />} />
                    <Route path="/contact" element={<ContactUs />} />
                    <Route path="/about" element={<AboutUs />} />
                    <Route path="/shipping" element={<ShippingPolicy />} />
                  </Routes>
                </Suspense>
              </BrowserRouter>
            </AppErrorBoundary>
          </TooltipProvider>
        </CurrencyProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
};

export default App;
