import { useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Save, Search, RefreshCw, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";

async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(path, { credentials: "include", ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as any)?.error || r.statusText);
  return data;
}

interface ProviderAccount {
  id: string;
  provider_id: string;
  name: string;
  api_key: string;
  api_url: string;
  priority: number;
  is_active: boolean;
}

interface Service {
  id: string;
  name: string;
  provider_id: string | null;
  provider_service_id: string;
  category: string;
  is_active: boolean | null;
}

interface ServiceMapping {
  id: string;
  service_id: string;
  provider_account_id: string;
  provider_service_id: string;
  sort_order: number;
  is_active: boolean;
}

export default function AdminServiceProviderMapping() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [mappings, setMappings] = useState<Record<string, { checked: boolean; serviceId: string; sortOrder: number; active: boolean }>>({});
  const [hasChanges, setHasChanges] = useState(false);

  // Fetch services
  const { data: services, isLoading: servicesLoading } = useQuery({
    queryKey: ["services-for-mapping"],
    queryFn: async () => {
      const data = await apiFetch("/api/admin/bundles/services");
      const rows = (Array.isArray(data) ? data : data?.services) || [];
      return (rows as Service[]).filter((s) => s.is_active !== false);
    },
  });

  // Fetch provider accounts
  const { data: accounts } = useQuery({
    queryKey: ["provider-accounts-for-mapping"],
    queryFn: async () => {
      const data = await apiFetch("/api/admin/provider-accounts");
      const rows = (Array.isArray(data) ? data : data?.accounts) || [];
      return (rows as ProviderAccount[]).filter((a) => a.is_active !== false);
    },
  });

  // Fetch existing mappings for selected service
  const { data: existingMappings, refetch: refetchMappings } = useQuery({
    queryKey: ["service-mappings", selectedServiceId],
    queryFn: async () => {
      if (!selectedServiceId) return [];
      const data = await apiFetch(
        `/api/admin/bundles/service-provider-mappings?service_id=${selectedServiceId}`
      );
      const rows = (Array.isArray(data) ? data : data?.mappings) || [];
      return rows as ServiceMapping[];
    },
    enabled: !!selectedServiceId,
  });

  // When service changes, reset mappings state
  const handleServiceChange = (serviceId: string) => {
    setSelectedServiceId(serviceId);
    setHasChanges(false);
    
    // Build initial mappings from existing data
    const newMappings: Record<string, { checked: boolean; serviceId: string; sortOrder: number; active: boolean }> = {};
    accounts?.forEach(account => {
      const existing = existingMappings?.find(m => m.provider_account_id === account.id);
      newMappings[account.id] = {
        checked: !!existing,
        serviceId: existing?.provider_service_id || services?.find(s => s.id === serviceId)?.provider_service_id || "",
        sortOrder: existing?.sort_order ?? account.priority,
        active: existing ? existing.is_active !== false : true,
      };
    });
    setMappings(newMappings);
  };

  // Update local state when existingMappings loads
  const updateMappingsFromExisting = () => {
    if (!accounts || !selectedServiceId) return;
    
    const selectedService = services?.find(s => s.id === selectedServiceId);
    const newMappings: Record<string, { checked: boolean; serviceId: string; sortOrder: number; active: boolean }> = {};
    
    accounts.forEach(account => {
      const existing = existingMappings?.find(m => m.provider_account_id === account.id);
      newMappings[account.id] = {
        checked: !!existing,
        serviceId: existing?.provider_service_id || selectedService?.provider_service_id || "",
        sortOrder: existing?.sort_order ?? account.priority,
        active: existing ? existing.is_active !== false : true,
      };
    });
    setMappings(newMappings);
  };

  // Sync when existingMappings changes
  useState(() => {
    if (existingMappings && accounts) {
      updateMappingsFromExisting();
    }
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedServiceId) return;

      // Server performs the diff (delete unchecked, upsert checked) in a tx.
      const payload = Object.entries(mappings).map(([accountId, data]) => ({
        provider_account_id: accountId,
        provider_service_id: data.serviceId,
        sort_order: data.sortOrder,
        checked: data.checked,
      }));

      await apiFetch("/api/admin/bundles/service-provider-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: selectedServiceId, mappings: payload }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service-mappings"] });
      refetchMappings();
      toast.success("Mappings saved successfully!");
      setHasChanges(false);
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to save mappings");
    },
  });

  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  // Queries the provider's own service list to confirm the mapped ID still exists.
  const verifyMapping = async (accountId: string, providerServiceId: string) => {
    if (!providerServiceId) {
      toast.error("Enter the provider service ID first");
      return;
    }
    setVerifyingId(accountId);
    try {
      const result = await apiFetch("/api/admin/service-provider-mappings/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_account_id: accountId, provider_service_id: providerServiceId }),
      }) as any;
      if (result?.verified) {
        toast.success(`Verified on ${result.provider}: ${result.service?.name || providerServiceId}`);
      } else {
        toast.error(result?.error || "Mapping could not be verified");
      }
    } catch (e: any) {
      toast.error(e.message || "Verification failed");
    } finally {
      setVerifyingId(null);
    }
  };

  const handleMappingChange = (accountId: string, field: "checked" | "serviceId" | "sortOrder" | "active", value: any) => {
    setMappings(prev => ({
      ...prev,
      [accountId]: {
        ...prev[accountId],
        [field]: value,
      },
    }));
    setHasChanges(true);
  };

  // Filter services by search
  const filteredServices = services?.filter(s => 
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedService = services?.find(s => s.id === selectedServiceId);

  return (
    <DashboardLayout>
      <div className="space-y-6 p-4 md:p-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate("/admin/provider-accounts")}
              className="shrink-0"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">Service Provider Mapping</h1>
              <p className="text-sm text-muted-foreground">
                Configure which provider accounts can fulfill each service
              </p>
            </div>
          </div>
          
          {hasChanges && (
            <Button 
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="gap-2"
            >
              {saveMutation.isPending ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save Mappings
            </Button>
          )}
        </div>

        {/* Service Selector */}
        <Card>
          <CardHeader>
            <CardTitle>Select Service</CardTitle>
            <CardDescription>
              Choose a service to configure its provider account mappings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search services..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            
            <Select value={selectedServiceId} onValueChange={handleServiceChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select a service to configure" />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {filteredServices?.map(service => (
                  <SelectItem key={service.id} value={service.id}>
                    <span className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {service.category}
                      </Badge>
                      {service.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Provider Account Mappings */}
        {selectedServiceId && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Configure: {selectedService?.name}
                <Badge variant="secondary">{selectedService?.category}</Badge>
              </CardTitle>
              <CardDescription>
                Select which provider accounts can fulfill this service and specify the provider service ID for each
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!accounts?.length ? (
                <p className="text-center text-muted-foreground py-6">
                  No provider accounts available. 
                  <Button variant="link" onClick={() => navigate("/admin/provider-accounts")}>
                    Create one first
                  </Button>
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">Enable</TableHead>
                      <TableHead>Provider Account</TableHead>
                      <TableHead>Provider Service ID</TableHead>
                      <TableHead>Priority (sort order)</TableHead>
                      <TableHead>Active</TableHead>
                      <TableHead className="text-right">Verify</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((account) => {
                      const mapping = mappings[account.id] || {
                        checked: false,
                        serviceId: selectedService?.provider_service_id || "",
                        sortOrder: account.priority,
                        active: true,
                      };
                      
                      return (
                        <TableRow key={account.id}>
                          <TableCell>
                            <Checkbox
                              checked={mapping.checked}
                              onCheckedChange={(checked) => 
                                handleMappingChange(account.id, "checked", checked)
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium">{account.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {account.provider_id} • Priority #{account.priority}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Input
                              value={mapping.serviceId}
                              onChange={(e) => 
                                handleMappingChange(account.id, "serviceId", e.target.value)
                              }
                              placeholder="e.g., 12761"
                              className="w-32"
                              disabled={!mapping.checked}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={mapping.sortOrder}
                              onChange={(e) => 
                                handleMappingChange(account.id, "sortOrder", Number.isFinite(parseInt(e.target.value)) ? parseInt(e.target.value) : 0)
                              }
                              className="w-20"
                              disabled={!mapping.checked}
                            />
                          </TableCell>
                          <TableCell>
                            <Switch
                              checked={mapping.active}
                              disabled={!mapping.checked}
                              onCheckedChange={(checked) =>
                                handleMappingChange(account.id, "active", checked)
                              }
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              disabled={!mapping.checked || verifyingId === account.id}
                              onClick={() => verifyMapping(account.id, mapping.serviceId)}
                            >
                              {verifyingId === account.id ? (
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ShieldCheck className="h-3.5 w-3.5" />
                              )}
                              Verify
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}

        {/* Info Card */}
        <Card className="border-warning/20 bg-warning/5">
          <CardContent className="p-4">
            <p className="text-sm text-warning-foreground/80">
              <strong>How it works:</strong> When the system needs to send an order for this service, 
              it will check all enabled provider accounts in order of their sort priority (0 = highest), 
              using least-recently-used order inside the same priority level. Soft errors such as 
              "active order with this link", low balance, or a disabled service move the same order to the 
              next provider with that provider's own service ID.
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
