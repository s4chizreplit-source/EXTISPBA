export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      apify_call_log: {
        Row: {
          created_at: string
          duration_ms: number | null
          error_message: string | null
          id: string
          results_count: number | null
          scrape_type: string
          source: string
          success: boolean
          user_id: string | null
          username: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          results_count?: number | null
          scrape_type: string
          source?: string
          success?: boolean
          user_id?: string | null
          username: string
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          results_count?: number | null
          scrape_type?: string
          source?: string
          success?: boolean
          user_id?: string | null
          username?: string
        }
        Relationships: []
      }
      bundle_items: {
        Row: {
          bundle_id: string
          created_at: string | null
          default_drip_interval: number | null
          default_drip_interval_unit: string | null
          default_drip_qty_per_run: number | null
          engagement_type: string
          id: string
          is_base: boolean | null
          price_per_k: number | null
          ratio_percent: number | null
          service_id: string | null
          sort_order: number | null
        }
        Insert: {
          bundle_id: string
          created_at?: string | null
          default_drip_interval?: number | null
          default_drip_interval_unit?: string | null
          default_drip_qty_per_run?: number | null
          engagement_type: string
          id?: string
          is_base?: boolean | null
          price_per_k?: number | null
          ratio_percent?: number | null
          service_id?: string | null
          sort_order?: number | null
        }
        Update: {
          bundle_id?: string
          created_at?: string | null
          default_drip_interval?: number | null
          default_drip_interval_unit?: string | null
          default_drip_qty_per_run?: number | null
          engagement_type?: string
          id?: string
          is_base?: boolean | null
          price_per_k?: number | null
          ratio_percent?: number | null
          service_id?: string | null
          sort_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "bundle_items_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "engagement_bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bundle_items_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_conversations: {
        Row: {
          created_at: string
          id: string
          last_message_at: string | null
          status: string
          updated_at: string
          user_email: string
          user_id: string
          user_name: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          last_message_at?: string | null
          status?: string
          updated_at?: string
          user_email: string
          user_id: string
          user_name?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          last_message_at?: string | null
          status?: string
          updated_at?: string
          user_email?: string
          user_id?: string
          user_name?: string | null
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          is_read: boolean | null
          message: string
          sender_id: string
          sender_role: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          is_read?: boolean | null
          message: string
          sender_id: string
          sender_role: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          is_read?: boolean | null
          message?: string
          sender_id?: string
          sender_role?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "chat_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      deposits: {
        Row: {
          admin_notes: string | null
          amount: number
          created_at: string | null
          currency: string | null
          id: string
          payment_method: string | null
          proof_url: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          admin_notes?: string | null
          amount: number
          created_at?: string | null
          currency?: string | null
          id?: string
          payment_method?: string | null
          proof_url?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          admin_notes?: string | null
          amount?: number
          created_at?: string | null
          currency?: string | null
          id?: string
          payment_method?: string | null
          proof_url?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      drip_feed_campaigns: {
        Row: {
          created_at: string
          id: string
          interval_minutes: number
          is_active: boolean
          last_error: string | null
          last_order_id: string | null
          link: string
          name: string | null
          next_run_at: string
          qty_per_run: number
          runs_done: number
          runs_failed: number
          service_id: string | null
          total_runs: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          interval_minutes?: number
          is_active?: boolean
          last_error?: string | null
          last_order_id?: string | null
          link: string
          name?: string | null
          next_run_at?: string
          qty_per_run: number
          runs_done?: number
          runs_failed?: number
          service_id?: string | null
          total_runs: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          interval_minutes?: number
          is_active?: boolean
          last_error?: string | null
          last_order_id?: string | null
          link?: string
          name?: string | null
          next_run_at?: string
          qty_per_run?: number
          runs_done?: number
          runs_failed?: number
          service_id?: string | null
          total_runs?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "drip_feed_campaigns_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      engagement_bundles: {
        Row: {
          ai_organic_enabled: boolean | null
          created_at: string | null
          description: string | null
          icon: string | null
          id: string
          is_active: boolean | null
          name: string
          platform: string
          provider_id: string | null
          sort_order: number | null
          updated_at: string | null
          use_custom_ratios: boolean | null
        }
        Insert: {
          ai_organic_enabled?: boolean | null
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          platform: string
          provider_id?: string | null
          sort_order?: number | null
          updated_at?: string | null
          use_custom_ratios?: boolean | null
        }
        Update: {
          ai_organic_enabled?: boolean | null
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          platform?: string
          provider_id?: string | null
          sort_order?: number | null
          updated_at?: string | null
          use_custom_ratios?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "engagement_bundles_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_bundles_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "providers_public"
            referencedColumns: ["id"]
          },
        ]
      }
      engagement_health_history: {
        Row: {
          botting_percent: number
          comments_count: number
          created_at: string
          engagement_order_id: string
          followers_count: number
          health_score: number
          id: string
          likes_count: number
          ratios: Json | null
          recorded_at: string
          saves_count: number
          shares_count: number
          views_count: number
          warnings: Json | null
        }
        Insert: {
          botting_percent?: number
          comments_count?: number
          created_at?: string
          engagement_order_id: string
          followers_count?: number
          health_score?: number
          id?: string
          likes_count?: number
          ratios?: Json | null
          recorded_at?: string
          saves_count?: number
          shares_count?: number
          views_count?: number
          warnings?: Json | null
        }
        Update: {
          botting_percent?: number
          comments_count?: number
          created_at?: string
          engagement_order_id?: string
          followers_count?: number
          health_score?: number
          id?: string
          likes_count?: number
          ratios?: Json | null
          recorded_at?: string
          saves_count?: number
          shares_count?: number
          views_count?: number
          warnings?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "engagement_health_history_engagement_order_id_fkey"
            columns: ["engagement_order_id"]
            isOneToOne: false
            referencedRelation: "engagement_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      engagement_order_items: {
        Row: {
          auto_refill_count: number
          auto_refill_enabled: boolean
          auto_refill_max: number
          auto_refill_threshold_pct: number
          created_at: string | null
          drip_interval: number | null
          drip_interval_unit: string | null
          drip_qty_per_run: number | null
          engagement_order_id: string
          engagement_type: string
          error_message: string | null
          id: string
          is_enabled: boolean | null
          last_refill_at: string | null
          price: number
          provider_order_id: string | null
          quantity: number
          service_id: string | null
          speed_preset: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          auto_refill_count?: number
          auto_refill_enabled?: boolean
          auto_refill_max?: number
          auto_refill_threshold_pct?: number
          created_at?: string | null
          drip_interval?: number | null
          drip_interval_unit?: string | null
          drip_qty_per_run?: number | null
          engagement_order_id: string
          engagement_type: string
          error_message?: string | null
          id?: string
          is_enabled?: boolean | null
          last_refill_at?: string | null
          price: number
          provider_order_id?: string | null
          quantity: number
          service_id?: string | null
          speed_preset?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          auto_refill_count?: number
          auto_refill_enabled?: boolean
          auto_refill_max?: number
          auto_refill_threshold_pct?: number
          created_at?: string | null
          drip_interval?: number | null
          drip_interval_unit?: string | null
          drip_qty_per_run?: number | null
          engagement_order_id?: string
          engagement_type?: string
          error_message?: string | null
          id?: string
          is_enabled?: boolean | null
          last_refill_at?: string | null
          price?: number
          provider_order_id?: string | null
          quantity?: number
          service_id?: string | null
          speed_preset?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "engagement_order_items_engagement_order_id_fkey"
            columns: ["engagement_order_id"]
            isOneToOne: false
            referencedRelation: "engagement_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_order_items_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      engagement_orders: {
        Row: {
          base_quantity: number
          bundle_id: string | null
          campaign_name: string | null
          completed_at: string | null
          created_at: string | null
          current_botting_percent: number | null
          current_health_score: number | null
          error_message: string | null
          id: string
          is_organic_mode: boolean | null
          last_health_check_at: string | null
          link: string
          order_number: number
          peak_hours_enabled: boolean | null
          status: string | null
          total_price: number
          updated_at: string | null
          user_id: string
          variance_percent: number | null
        }
        Insert: {
          base_quantity: number
          bundle_id?: string | null
          campaign_name?: string | null
          completed_at?: string | null
          created_at?: string | null
          current_botting_percent?: number | null
          current_health_score?: number | null
          error_message?: string | null
          id?: string
          is_organic_mode?: boolean | null
          last_health_check_at?: string | null
          link: string
          order_number?: number
          peak_hours_enabled?: boolean | null
          status?: string | null
          total_price: number
          updated_at?: string | null
          user_id: string
          variance_percent?: number | null
        }
        Update: {
          base_quantity?: number
          bundle_id?: string | null
          campaign_name?: string | null
          completed_at?: string | null
          created_at?: string | null
          current_botting_percent?: number | null
          current_health_score?: number | null
          error_message?: string | null
          id?: string
          is_organic_mode?: boolean | null
          last_health_check_at?: string | null
          link?: string
          order_number?: number
          peak_hours_enabled?: boolean | null
          status?: string | null
          total_price?: number
          updated_at?: string | null
          user_id?: string
          variance_percent?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "engagement_orders_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "engagement_bundles"
            referencedColumns: ["id"]
          },
        ]
      }
      engagement_presets: {
        Row: {
          comments: number
          created_at: string
          default_link: string | null
          drip_minutes: number
          likes: number
          mode: string
          reposts: number
          saves: number
          shares: number
          updated_at: string
          user_id: string
          views: number
        }
        Insert: {
          comments?: number
          created_at?: string
          default_link?: string | null
          drip_minutes?: number
          likes?: number
          mode?: string
          reposts?: number
          saves?: number
          shares?: number
          updated_at?: string
          user_id: string
          views?: number
        }
        Update: {
          comments?: number
          created_at?: string
          default_link?: string | null
          drip_minutes?: number
          likes?: number
          mode?: string
          reposts?: number
          saves?: number
          shares?: number
          updated_at?: string
          user_id?: string
          views?: number
        }
        Relationships: []
      }
      instagram_accounts: {
        Row: {
          auto_boost_enabled: boolean | null
          avatar_url: string | null
          biography: string | null
          created_at: string
          default_bundle_id: string | null
          followers: number | null
          following: number | null
          full_name: string | null
          id: string
          ig_user_id: string | null
          is_private: boolean | null
          is_verified: boolean | null
          last_fetched_at: string | null
          last_scraped_at: string | null
          posts_count: number | null
          status: string
          updated_at: string
          user_id: string
          username: string
        }
        Insert: {
          auto_boost_enabled?: boolean | null
          avatar_url?: string | null
          biography?: string | null
          created_at?: string
          default_bundle_id?: string | null
          followers?: number | null
          following?: number | null
          full_name?: string | null
          id?: string
          ig_user_id?: string | null
          is_private?: boolean | null
          is_verified?: boolean | null
          last_fetched_at?: string | null
          last_scraped_at?: string | null
          posts_count?: number | null
          status?: string
          updated_at?: string
          user_id: string
          username: string
        }
        Update: {
          auto_boost_enabled?: boolean | null
          avatar_url?: string | null
          biography?: string | null
          created_at?: string
          default_bundle_id?: string | null
          followers?: number | null
          following?: number | null
          full_name?: string | null
          id?: string
          ig_user_id?: string | null
          is_private?: boolean | null
          is_verified?: boolean | null
          last_fetched_at?: string | null
          last_scraped_at?: string | null
          posts_count?: number | null
          status?: string
          updated_at?: string
          user_id?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "instagram_accounts_default_bundle_id_fkey"
            columns: ["default_bundle_id"]
            isOneToOne: false
            referencedRelation: "engagement_bundles"
            referencedColumns: ["id"]
          },
        ]
      }
      instagram_link_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          user_id: string
          username: string
        }
        Insert: {
          created_at?: string
          event_type?: string
          id?: string
          user_id: string
          username: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          user_id?: string
          username?: string
        }
        Relationships: []
      }
      instagram_media: {
        Row: {
          account_id: string
          caption: string | null
          comment_count: number | null
          created_at: string
          detected_at: string
          engagement_applied: boolean
          id: string
          like_count: number | null
          media_id: string
          media_type: string | null
          permalink: string
          posted_at: string | null
          shortcode: string | null
          thumbnail_url: string | null
          updated_at: string
          user_id: string
          view_count: number | null
        }
        Insert: {
          account_id: string
          caption?: string | null
          comment_count?: number | null
          created_at?: string
          detected_at?: string
          engagement_applied?: boolean
          id?: string
          like_count?: number | null
          media_id: string
          media_type?: string | null
          permalink: string
          posted_at?: string | null
          shortcode?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id: string
          view_count?: number | null
        }
        Update: {
          account_id?: string
          caption?: string | null
          comment_count?: number | null
          created_at?: string
          detected_at?: string
          engagement_applied?: boolean
          id?: string
          like_count?: number | null
          media_id?: string
          media_type?: string | null
          permalink?: string
          posted_at?: string | null
          shortcode?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id?: string
          view_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "instagram_media_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "instagram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      instagram_poll_state: {
        Row: {
          account_id: string
          last_polled_at: string
          last_seen_media_id: string | null
        }
        Insert: {
          account_id: string
          last_polled_at?: string
          last_seen_media_id?: string | null
        }
        Update: {
          account_id?: string
          last_polled_at?: string
          last_seen_media_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "instagram_poll_state_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "instagram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      mass_order_batch_items: {
        Row: {
          batch_id: string
          created_at: string
          engagement_order_id: string | null
          engagement_order_number: number | null
          error_message: string | null
          id: string
          link: string
          payload: Json | null
          price: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          engagement_order_id?: string | null
          engagement_order_number?: number | null
          error_message?: string | null
          id?: string
          link: string
          payload?: Json | null
          price?: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          engagement_order_id?: string | null
          engagement_order_number?: number | null
          error_message?: string | null
          id?: string
          link?: string
          payload?: Json | null
          price?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mass_order_batch_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "mass_order_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      mass_order_batches: {
        Row: {
          created_at: string
          failed_count: number
          id: string
          name: string | null
          platform: string | null
          status: string
          success_count: number
          total_count: number
          total_price: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          failed_count?: number
          id?: string
          name?: string | null
          platform?: string | null
          status?: string
          success_count?: number
          total_count?: number
          total_price?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          failed_count?: number
          id?: string
          name?: string | null
          platform?: string | null
          status?: string
          success_count?: number
          total_count?: number
          total_price?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          auto_refill_count: number
          auto_refill_enabled: boolean
          auto_refill_max: number
          auto_refill_threshold_pct: number
          created_at: string | null
          drip_interval: number | null
          drip_interval_unit: string | null
          drip_quantity_per_run: number | null
          drip_runs: number | null
          error_message: string | null
          id: string
          is_drip_feed: boolean | null
          is_organic_mode: boolean | null
          last_refill_at: string | null
          link: string
          order_number: number
          peak_hours_enabled: boolean | null
          price: number
          provider_order_id: string | null
          quantity: number
          remains: number | null
          service_id: string | null
          start_count: number | null
          status: string | null
          updated_at: string | null
          user_id: string
          variance_percent: number | null
        }
        Insert: {
          auto_refill_count?: number
          auto_refill_enabled?: boolean
          auto_refill_max?: number
          auto_refill_threshold_pct?: number
          created_at?: string | null
          drip_interval?: number | null
          drip_interval_unit?: string | null
          drip_quantity_per_run?: number | null
          drip_runs?: number | null
          error_message?: string | null
          id?: string
          is_drip_feed?: boolean | null
          is_organic_mode?: boolean | null
          last_refill_at?: string | null
          link: string
          order_number?: number
          peak_hours_enabled?: boolean | null
          price: number
          provider_order_id?: string | null
          quantity: number
          remains?: number | null
          service_id?: string | null
          start_count?: number | null
          status?: string | null
          updated_at?: string | null
          user_id: string
          variance_percent?: number | null
        }
        Update: {
          auto_refill_count?: number
          auto_refill_enabled?: boolean
          auto_refill_max?: number
          auto_refill_threshold_pct?: number
          created_at?: string | null
          drip_interval?: number | null
          drip_interval_unit?: string | null
          drip_quantity_per_run?: number | null
          drip_runs?: number | null
          error_message?: string | null
          id?: string
          is_drip_feed?: boolean | null
          is_organic_mode?: boolean | null
          last_refill_at?: string | null
          link?: string
          order_number?: number
          peak_hours_enabled?: boolean | null
          price?: number
          provider_order_id?: string | null
          quantity?: number
          remains?: number | null
          service_id?: string | null
          start_count?: number | null
          status?: string | null
          updated_at?: string | null
          user_id?: string
          variance_percent?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      organic_run_schedule: {
        Row: {
          base_quantity: number
          completed_at: string | null
          created_at: string | null
          engagement_order_item_id: string | null
          error_message: string | null
          id: string
          last_status_check: string | null
          order_id: string | null
          peak_multiplier: number | null
          provider_account_id: string | null
          provider_account_name: string | null
          provider_charge: number | null
          provider_order_id: string | null
          provider_remains: number | null
          provider_response: Json | null
          provider_start_count: number | null
          provider_status: string | null
          quantity_to_send: number
          retry_count: number | null
          rotation_lock_key: string | null
          run_number: number
          scheduled_at: string
          started_at: string | null
          status: string | null
          variance_applied: number | null
        }
        Insert: {
          base_quantity: number
          completed_at?: string | null
          created_at?: string | null
          engagement_order_item_id?: string | null
          error_message?: string | null
          id?: string
          last_status_check?: string | null
          order_id?: string | null
          peak_multiplier?: number | null
          provider_account_id?: string | null
          provider_account_name?: string | null
          provider_charge?: number | null
          provider_order_id?: string | null
          provider_remains?: number | null
          provider_response?: Json | null
          provider_start_count?: number | null
          provider_status?: string | null
          quantity_to_send: number
          retry_count?: number | null
          rotation_lock_key?: string | null
          run_number: number
          scheduled_at: string
          started_at?: string | null
          status?: string | null
          variance_applied?: number | null
        }
        Update: {
          base_quantity?: number
          completed_at?: string | null
          created_at?: string | null
          engagement_order_item_id?: string | null
          error_message?: string | null
          id?: string
          last_status_check?: string | null
          order_id?: string | null
          peak_multiplier?: number | null
          provider_account_id?: string | null
          provider_account_name?: string | null
          provider_charge?: number | null
          provider_order_id?: string | null
          provider_remains?: number | null
          provider_response?: Json | null
          provider_start_count?: number | null
          provider_status?: string | null
          quantity_to_send?: number
          retry_count?: number | null
          rotation_lock_key?: string | null
          run_number?: number
          scheduled_at?: string
          started_at?: string | null
          status?: string | null
          variance_applied?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "organic_run_schedule_engagement_order_item_id_fkey"
            columns: ["engagement_order_item_id"]
            isOneToOne: false
            referencedRelation: "engagement_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organic_run_schedule_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organic_run_schedule_provider_account_id_fkey"
            columns: ["provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      oxapay_activity_log: {
        Row: {
          amount_usd: number | null
          created_at: string
          event: string
          http_status: number | null
          id: string
          message: string | null
          ok: boolean
          order_id: string | null
          payload: Json | null
          plan_type: string | null
          provider_status: string | null
          purpose: string | null
          source: string
          user_id: string | null
        }
        Insert: {
          amount_usd?: number | null
          created_at?: string
          event: string
          http_status?: number | null
          id?: string
          message?: string | null
          ok?: boolean
          order_id?: string | null
          payload?: Json | null
          plan_type?: string | null
          provider_status?: string | null
          purpose?: string | null
          source: string
          user_id?: string | null
        }
        Update: {
          amount_usd?: number | null
          created_at?: string
          event?: string
          http_status?: number | null
          id?: string
          message?: string | null
          ok?: boolean
          order_id?: string | null
          payload?: Json | null
          plan_type?: string | null
          provider_status?: string | null
          purpose?: string | null
          source?: string
          user_id?: string | null
        }
        Relationships: []
      }
      oxapay_deposits: {
        Row: {
          amount_inr: number | null
          amount_usd: number
          created_at: string
          credited: boolean
          email: string | null
          id: string
          order_id: string
          pay_link: string | null
          plan_type: string | null
          purpose: string
          raw_response: Json | null
          status: string
          track_id: string | null
          updated_at: string
          user_id: string
          webhook_payload: Json | null
        }
        Insert: {
          amount_inr?: number | null
          amount_usd: number
          created_at?: string
          credited?: boolean
          email?: string | null
          id?: string
          order_id: string
          pay_link?: string | null
          plan_type?: string | null
          purpose?: string
          raw_response?: Json | null
          status?: string
          track_id?: string | null
          updated_at?: string
          user_id: string
          webhook_payload?: Json | null
        }
        Update: {
          amount_inr?: number | null
          amount_usd?: number
          created_at?: string
          credited?: boolean
          email?: string | null
          id?: string
          order_id?: string
          pay_link?: string | null
          plan_type?: string | null
          purpose?: string
          raw_response?: Json | null
          status?: string
          track_id?: string | null
          updated_at?: string
          user_id?: string
          webhook_payload?: Json | null
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          created_at: string | null
          global_markup_percent: number | null
          id: string
          maintenance_mode: boolean | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          global_markup_percent?: number | null
          id?: string
          maintenance_mode?: boolean | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          global_markup_percent?: number | null
          id?: string
          maintenance_mode?: boolean | null
          updated_at?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          api_key: string | null
          avatar_url: string | null
          created_at: string | null
          currency: string | null
          email: string
          full_name: string | null
          id: string
          is_organic_mode_default: boolean | null
          organic_peak_hours_enabled: boolean | null
          organic_ratios: Json | null
          organic_variance_percent: number | null
          referral_code: string | null
          referral_earnings: number
          referred_by: string | null
          telegram_chat_id: string | null
          telegram_id: string | null
          telegram_notifications_enabled: boolean | null
          telegram_username: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          api_key?: string | null
          avatar_url?: string | null
          created_at?: string | null
          currency?: string | null
          email: string
          full_name?: string | null
          id?: string
          is_organic_mode_default?: boolean | null
          organic_peak_hours_enabled?: boolean | null
          organic_ratios?: Json | null
          organic_variance_percent?: number | null
          referral_code?: string | null
          referral_earnings?: number
          referred_by?: string | null
          telegram_chat_id?: string | null
          telegram_id?: string | null
          telegram_notifications_enabled?: boolean | null
          telegram_username?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          api_key?: string | null
          avatar_url?: string | null
          created_at?: string | null
          currency?: string | null
          email?: string
          full_name?: string | null
          id?: string
          is_organic_mode_default?: boolean | null
          organic_peak_hours_enabled?: boolean | null
          organic_ratios?: Json | null
          organic_variance_percent?: number | null
          referral_code?: string | null
          referral_earnings?: number
          referred_by?: string | null
          telegram_chat_id?: string | null
          telegram_id?: string | null
          telegram_notifications_enabled?: boolean | null
          telegram_username?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      promo_codes: {
        Row: {
          bonus_type: string
          bonus_value: number
          code: string
          created_at: string
          created_by: string | null
          description: string | null
          expires_at: string | null
          id: string
          is_active: boolean
          max_uses: number | null
          min_deposit_usd: number
          used_count: number
        }
        Insert: {
          bonus_type?: string
          bonus_value: number
          code: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_uses?: number | null
          min_deposit_usd?: number
          used_count?: number
        }
        Update: {
          bonus_type?: string
          bonus_value?: number
          code?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_uses?: number | null
          min_deposit_usd?: number
          used_count?: number
        }
        Relationships: []
      }
      promo_redemptions: {
        Row: {
          bonus_amount_usd: number
          deposit_amount_usd: number
          id: string
          promo_code_id: string
          redeemed_at: string
          user_id: string
        }
        Insert: {
          bonus_amount_usd: number
          deposit_amount_usd: number
          id?: string
          promo_code_id: string
          redeemed_at?: string
          user_id: string
        }
        Update: {
          bonus_amount_usd?: number
          deposit_amount_usd?: number
          id?: string
          promo_code_id?: string
          redeemed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promo_redemptions_promo_code_id_fkey"
            columns: ["promo_code_id"]
            isOneToOne: false
            referencedRelation: "promo_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_accounts: {
        Row: {
          api_key: string
          api_url: string
          balance: number | null
          balance_checked_at: string | null
          balance_currency: string | null
          created_at: string | null
          delivery_multiplier: number
          id: string
          is_active: boolean | null
          last_balance_error: string | null
          last_low_balance_alert_at: string | null
          last_used_at: string | null
          low_balance_threshold: number
          name: string
          priority: number | null
          provider_id: string
          updated_at: string | null
        }
        Insert: {
          api_key: string
          api_url: string
          balance?: number | null
          balance_checked_at?: string | null
          balance_currency?: string | null
          created_at?: string | null
          delivery_multiplier?: number
          id?: string
          is_active?: boolean | null
          last_balance_error?: string | null
          last_low_balance_alert_at?: string | null
          last_used_at?: string | null
          low_balance_threshold?: number
          name: string
          priority?: number | null
          provider_id: string
          updated_at?: string | null
        }
        Update: {
          api_key?: string
          api_url?: string
          balance?: number | null
          balance_checked_at?: string | null
          balance_currency?: string | null
          created_at?: string | null
          delivery_multiplier?: number
          id?: string
          is_active?: boolean | null
          last_balance_error?: string | null
          last_low_balance_alert_at?: string | null
          last_used_at?: string | null
          low_balance_threshold?: number
          name?: string
          priority?: number | null
          provider_id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      provider_balance_history: {
        Row: {
          balance: number | null
          balance_currency: string | null
          checked_at: string
          delta: number | null
          error_message: string | null
          id: string
          previous_balance: number | null
          provider_account_id: string
          source: string
          status: string
        }
        Insert: {
          balance?: number | null
          balance_currency?: string | null
          checked_at?: string
          delta?: number | null
          error_message?: string | null
          id?: string
          previous_balance?: number | null
          provider_account_id: string
          source?: string
          status?: string
        }
        Update: {
          balance?: number | null
          balance_currency?: string | null
          checked_at?: string
          delta?: number | null
          error_message?: string | null
          id?: string
          previous_balance?: number | null
          provider_account_id?: string
          source?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_balance_history_provider_account_id_fkey"
            columns: ["provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      providers: {
        Row: {
          api_key: string
          api_url: string
          created_at: string | null
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          api_key: string
          api_url: string
          created_at?: string | null
          id: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          api_key?: string
          api_url?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      razorpay_webhook_events: {
        Row: {
          event_id: string
          event_type: string | null
          id: string
          payload: Json | null
          payment_id: string | null
          processed_at: string
        }
        Insert: {
          event_id: string
          event_type?: string | null
          id?: string
          payload?: Json | null
          payment_id?: string | null
          processed_at?: string
        }
        Update: {
          event_id?: string
          event_type?: string | null
          id?: string
          payload?: Json | null
          payment_id?: string | null
          processed_at?: string
        }
        Relationships: []
      }
      security_audit_log: {
        Row: {
          category: string
          created_at: string
          http_status: number | null
          id: string
          ip: string | null
          metadata: Json | null
          order_id: string | null
          payload: Json | null
          provider: string | null
          reason: string
          request_path: string | null
          source: string
          track_id: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          category: string
          created_at?: string
          http_status?: number | null
          id?: string
          ip?: string | null
          metadata?: Json | null
          order_id?: string | null
          payload?: Json | null
          provider?: string | null
          reason: string
          request_path?: string | null
          source: string
          track_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          http_status?: number | null
          id?: string
          ip?: string | null
          metadata?: Json | null
          order_id?: string | null
          payload?: Json | null
          provider?: string | null
          reason?: string
          request_path?: string | null
          source?: string
          track_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      service_provider_mapping: {
        Row: {
          backup_provider_account_id: string | null
          backup_provider_service_id: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          provider_account_id: string | null
          provider_service_id: string
          service_id: string | null
          sort_order: number | null
        }
        Insert: {
          backup_provider_account_id?: string | null
          backup_provider_service_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          provider_account_id?: string | null
          provider_service_id: string
          service_id?: string | null
          sort_order?: number | null
        }
        Update: {
          backup_provider_account_id?: string | null
          backup_provider_service_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          provider_account_id?: string | null
          provider_service_id?: string
          service_id?: string | null
          sort_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "service_provider_mapping_backup_provider_account_id_fkey"
            columns: ["backup_provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_provider_mapping_provider_account_id_fkey"
            columns: ["provider_account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_provider_mapping_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          cancel_allowed: string | null
          category: string
          created_at: string | null
          description: string | null
          drip_feed_enabled: boolean | null
          drop_type: string | null
          id: string
          is_active: boolean | null
          max_quantity: number
          min_quantity: number
          name: string
          price: number
          provider_id: string | null
          provider_service_id: string
          quality: string | null
          refill: string | null
          speed: string | null
          start_time: string | null
          updated_at: string | null
        }
        Insert: {
          cancel_allowed?: string | null
          category: string
          created_at?: string | null
          description?: string | null
          drip_feed_enabled?: boolean | null
          drop_type?: string | null
          id?: string
          is_active?: boolean | null
          max_quantity?: number
          min_quantity?: number
          name: string
          price?: number
          provider_id?: string | null
          provider_service_id: string
          quality?: string | null
          refill?: string | null
          speed?: string | null
          start_time?: string | null
          updated_at?: string | null
        }
        Update: {
          cancel_allowed?: string | null
          category?: string
          created_at?: string | null
          description?: string | null
          drip_feed_enabled?: boolean | null
          drop_type?: string | null
          id?: string
          is_active?: boolean | null
          max_quantity?: number
          min_quantity?: number
          name?: string
          price?: number
          provider_id?: string | null
          provider_service_id?: string
          quality?: string | null
          refill?: string | null
          speed?: string | null
          start_time?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "services_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "providers_public"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_requests: {
        Row: {
          admin_notes: string | null
          created_at: string | null
          email: string
          full_name: string
          id: string
          message: string | null
          phone: string
          plan_type: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          admin_notes?: string | null
          created_at?: string | null
          email: string
          full_name: string
          id?: string
          message?: string | null
          phone: string
          plan_type: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          admin_notes?: string | null
          created_at?: string | null
          email?: string
          full_name?: string
          id?: string
          message?: string | null
          phone?: string
          plan_type?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          activated_at: string | null
          activated_by: string | null
          created_at: string | null
          expires_at: string | null
          id: string
          plan_type: string
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          activated_at?: string | null
          activated_by?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: string
          plan_type?: string
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          activated_at?: string | null
          activated_by?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: string
          plan_type?: string
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      support_tickets: {
        Row: {
          category: string | null
          created_at: string | null
          id: string
          message: string
          order_id: string | null
          priority: string | null
          status: string | null
          subject: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          id?: string
          message: string
          order_id?: string | null
          priority?: string | null
          status?: string | null
          subject: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          category?: string | null
          created_at?: string | null
          id?: string
          message?: string
          order_id?: string | null
          priority?: string | null
          status?: string | null
          subject?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_tickets_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_engagement_links: {
        Row: {
          code_expires_at: string | null
          created_at: string
          id: string
          link_code: string | null
          linked_at: string | null
          status: string
          telegram_chat_id: number | null
          telegram_username: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          code_expires_at?: string | null
          created_at?: string
          id?: string
          link_code?: string | null
          linked_at?: string | null
          status?: string
          telegram_chat_id?: number | null
          telegram_username?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          code_expires_at?: string | null
          created_at?: string
          id?: string
          link_code?: string | null
          linked_at?: string | null
          status?: string
          telegram_chat_id?: number | null
          telegram_username?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      transactions: {
        Row: {
          amount: number
          balance_after: number
          created_at: string | null
          description: string | null
          id: string
          order_id: string | null
          payment_method: string | null
          payment_reference: string | null
          status: string | null
          type: string
          user_id: string
        }
        Insert: {
          amount: number
          balance_after: number
          created_at?: string | null
          description?: string | null
          id?: string
          order_id?: string | null
          payment_method?: string | null
          payment_reference?: string | null
          status?: string | null
          type: string
          user_id: string
        }
        Update: {
          amount?: number
          balance_after?: number
          created_at?: string | null
          description?: string | null
          id?: string
          order_id?: string | null
          payment_method?: string | null
          payment_reference?: string | null
          status?: string | null
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      wallets: {
        Row: {
          balance: number | null
          created_at: string | null
          id: string
          total_deposited: number | null
          total_spent: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          balance?: number | null
          created_at?: string | null
          id?: string
          total_deposited?: number | null
          total_spent?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          balance?: number | null
          created_at?: string | null
          id?: string
          total_deposited?: number | null
          total_spent?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          created_at: string
          event_status: string | null
          first_seen_at: string
          http_status: number | null
          id: string
          message: string | null
          order_id: string
          outcome: string
          payload: Json | null
          payload_hash: string
          processed_at: string | null
          provider: string
          track_id: string | null
        }
        Insert: {
          created_at?: string
          event_status?: string | null
          first_seen_at?: string
          http_status?: number | null
          id?: string
          message?: string | null
          order_id: string
          outcome?: string
          payload?: Json | null
          payload_hash: string
          processed_at?: string | null
          provider: string
          track_id?: string | null
        }
        Update: {
          created_at?: string
          event_status?: string | null
          first_seen_at?: string
          http_status?: number | null
          id?: string
          message?: string | null
          order_id?: string
          outcome?: string
          payload?: Json | null
          payload_hash?: string
          processed_at?: string | null
          provider?: string
          track_id?: string | null
        }
        Relationships: []
      }
      zapupi_deposits: {
        Row: {
          amount_inr: number
          amount_usd: number | null
          created_at: string
          credited: boolean
          id: string
          order_id: string
          payment_url: string | null
          raw_response: Json | null
          status: string
          txn_id: string | null
          updated_at: string
          user_id: string
          utr: string | null
        }
        Insert: {
          amount_inr: number
          amount_usd?: number | null
          created_at?: string
          credited?: boolean
          id?: string
          order_id: string
          payment_url?: string | null
          raw_response?: Json | null
          status?: string
          txn_id?: string | null
          updated_at?: string
          user_id: string
          utr?: string | null
        }
        Update: {
          amount_inr?: number
          amount_usd?: number | null
          created_at?: string
          credited?: boolean
          id?: string
          order_id?: string
          payment_url?: string | null
          raw_response?: Json | null
          status?: string
          txn_id?: string | null
          updated_at?: string
          user_id?: string
          utr?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      providers_public: {
        Row: {
          api_url: string | null
          created_at: string | null
          id: string | null
          is_active: boolean | null
          name: string | null
          updated_at: string | null
        }
        Insert: {
          api_url?: string | null
          created_at?: string | null
          id?: string | null
          is_active?: boolean | null
          name?: string | null
          updated_at?: string | null
        }
        Update: {
          api_url?: string | null
          created_at?: string | null
          id?: string | null
          is_active?: boolean | null
          name?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      activate_subscription_oxapay: {
        Args: {
          p_amount_usd: number
          p_order_id: string
          p_plan: string
          p_track_id: string
          p_user_id: string
        }
        Returns: Json
      }
      apply_referral_bonus: {
        Args: { p_deposit_usd: number; p_referee: string }
        Returns: Json
      }
      cleanup_old_completed_engagement_orders: { Args: never; Returns: Json }
      credit_wallet_oxapay: {
        Args: {
          p_amount_usd: number
          p_order_id: string
          p_track_id: string
          p_user_id: string
        }
        Returns: Json
      }
      credit_wallet_razorpay: {
        Args: {
          p_amount_inr: number
          p_amount_usd: number
          p_payment_id: string
          p_user_id: string
        }
        Returns: Json
      }
      credit_wallet_zapupi: {
        Args: {
          p_amount_inr: number
          p_amount_usd: number
          p_order_id: string
          p_txn_id: string
          p_user_id: string
          p_utr: string
        }
        Returns: Json
      }
      debit_wallet_for_order:
        | { Args: { p_amount: number; p_user_id: string }; Returns: number }
        | {
            Args: {
              p_amount: number
              p_description?: string
              p_idempotency_key?: string
              p_order_id?: string
              p_user_id: string
            }
            Returns: Json
          }
      ensure_user_profile: { Args: never; Returns: undefined }
      expire_subscriptions: { Args: never; Returns: number }
      export_auth_hashes: {
        Args: never
        Returns: {
          created_at: string
          email: string
          email_confirmed_at: string
          encrypted_password: string
          id: string
          phone: string
          raw_app_meta_data: Json
          raw_user_meta_data: Json
        }[]
      }
      generate_telegram_link_code: { Args: never; Returns: Json }
      get_admin_dashboard_stats: { Args: never; Returns: Json }
      get_admin_users_summary: { Args: never; Returns: Json }
      get_cron_jobs: {
        Args: never
        Returns: {
          active: boolean
          command: string
          database: string
          jobid: number
          jobname: string
          nodename: string
          nodeport: number
          schedule: string
          username: string
        }[]
      }
      get_cron_run_details: {
        Args: { p_job_id: number }
        Returns: {
          command: string
          database: string
          end_time: string
          job_pid: number
          jobid: number
          return_message: string
          runid: number
          start_time: string
          status: string
          username: string
        }[]
      }
      get_orders_by_link: {
        Args: { _link: string; _user_id: string }
        Returns: {
          base_quantity: number
          bundle_id: string | null
          campaign_name: string | null
          completed_at: string | null
          created_at: string | null
          current_botting_percent: number | null
          current_health_score: number | null
          error_message: string | null
          id: string
          is_organic_mode: boolean | null
          last_health_check_at: string | null
          link: string
          order_number: number
          peak_hours_enabled: boolean | null
          status: string | null
          total_price: number
          updated_at: string | null
          user_id: string
          variance_percent: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "engagement_orders"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_posts_with_order_summary: {
        Args: { _user_id: string }
        Returns: {
          account_username: string
          active_orders: number
          caption: string
          completed_orders: number
          media_id: string
          media_type: string
          permalink: string
          posted_at: string
          shortcode: string
          thumbnail_url: string
          total_orders: number
          total_spent: number
        }[]
      }
      get_provider_topup_breakdown: {
        Args: never
        Returns: {
          pending_quantity: number
          pending_runs: number
          pending_user_usd: number
          provider_account_id: string
          provider_id: string
          provider_name: string
          service_category: string
          service_id: string
          service_name: string
        }[]
      }
      get_provider_topup_plan: {
        Args: never
        Returns: {
          markup_percent: number
          pending_runs: number
          pending_user_usd: number
          provider_account_id: string
          provider_id: string
          provider_name: string
        }[]
      }
      get_public_markup: { Args: never; Returns: number }
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
      get_user_tier: { Args: { _user_id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_maintenance_mode: { Args: never; Returns: boolean }
      pg_advisory_xact_lock: { Args: { key: number }; Returns: undefined }
      redeem_promo_code: {
        Args: { p_code: string; p_deposit_usd: number }
        Returns: Json
      }
      redeem_telegram_link_code: {
        Args: { p_chat_id: number; p_code: string; p_username: string }
        Returns: Json
      }
      reschedule_organic_run: {
        Args: { p_quantity: number; p_run_id: string; p_scheduled_at: string }
        Returns: Json
      }
      set_referrer_by_code: { Args: { p_code: string }; Returns: Json }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
