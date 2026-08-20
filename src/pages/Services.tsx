import { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Zap, Star, Clock, ArrowRight, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useServices } from '@/hooks/useServices';
import { useCurrency } from '@/hooks/useCurrency';
import { PageMeta } from '@/components/seo/PageMeta';

const categories = [
  'All',
  'Instagram Views',
  'Instagram Likes',
  'Instagram Followers',
  'TikTok Views',
  'TikTok Likes',
  'YouTube Views',
  'Twitter/X',
];

export default function Services() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const { formatPrice } = useCurrency();

  const { services } = useServices();

  const filteredServices = services?.filter(service => {
    const matchesSearch = service.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         service.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || service.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const getSpeedBadge = (speed: string | null) => {
    switch (speed) {
      case 'instant': return { icon: Zap, color: 'text-success', label: 'Instant' };
      case 'fast': return { icon: Zap, color: 'text-warning', label: 'Fast' };
      case 'medium': return { icon: Clock, color: 'text-primary', label: 'Medium' };
      default: return { icon: Clock, color: 'text-muted-foreground', label: 'Slow' };
    }
  };

  const getQualityBadge = (quality: string | null) => {
    switch (quality) {
      case 'premium': return { color: 'bg-accent/20 text-accent', label: '⭐ Premium' };
      case 'high': return { color: 'bg-success/20 text-success', label: 'High Quality' };
      default: return { color: 'bg-muted text-muted-foreground', label: 'Standard' };
    }
  };

  return (
    <DashboardLayout>
      <PageMeta
        title="Services & Pricing — Extips Panel Pro"
        description="Browse Extips Panel Pro services: Instagram, YouTube, TikTok and Twitter/X engagement with transparent pricing and natural delivery."
        canonicalPath="/services"
        breadcrumbs={[
          { name: 'Home', path: '/' },
          { name: 'Services', path: '/services' },
        ]}
      />
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold mb-2">Services</h1>
          <p className="text-muted-foreground">Browse our collection of social media growth services.</p>
        </div>

        {/* Search and Filter */}
        <div className="flex flex-col md:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search services..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 input-glass"
            />
          </div>
        </div>

        {/* Category Pills */}
        <div className="flex flex-wrap gap-2">
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                selectedCategory === category
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
              }`}
            >
              {category}
            </button>
          ))}
        </div>

        {/* Services Grid - Instant render with fallback */}
        {filteredServices && filteredServices.length > 0 ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredServices.map((service) => {
              const speed = getSpeedBadge(service.speed);
              const quality = getQualityBadge(service.quality);
              
              return (
                <div 
                  key={service.id} 
                  className="glass-card p-6 hover:border-primary/30 transition-all duration-300 group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <span className="text-xs text-muted-foreground">{service.category}</span>
                      <h3 className="font-semibold mt-1 group-hover:text-primary transition-colors">
                        {service.name}
                      </h3>
                    </div>
                    <span className={`px-2 py-1 rounded-full text-xs ${quality.color}`}>
                      {quality.label}
                    </span>
                  </div>

                  {service.description && (
                    <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                      {service.description}
                    </p>
                  )}

                  <div className="flex items-center gap-4 mb-4 text-sm">
                    <div className="flex items-center gap-1">
                      <speed.icon className={`h-4 w-4 ${speed.color}`} />
                      <span className="text-muted-foreground">{speed.label}</span>
                    </div>
                    {service.drip_feed_enabled && (
                      <span className="text-success flex items-center gap-1">
                        <Star className="h-3 w-3" />
                        Drip Feed
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-4 border-t border-border">
                    <div>
                      <p className="text-2xl font-bold gradient-text">{formatPrice(service.price)}</p>
                      <p className="text-xs text-muted-foreground">per 1000</p>
                    </div>
                    <Link to={`/order?service=${service.id}`}>
                      <Button variant="gradient" size="sm" className="gap-1">
                        Order
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </Link>
                  </div>

                  <div className="mt-4 pt-4 border-t border-border text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <span>Min: {service.min_quantity.toLocaleString()}</span>
                      <span>Max: {service.max_quantity.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="glass-card p-12 text-center">
            <p className="text-muted-foreground">No services found matching your criteria.</p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
