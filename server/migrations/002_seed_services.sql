-- Starter catalog. Safe to keep: inserts only when the catalog is empty.
INSERT INTO services (platform, category, name, description, price_per_1k, min_quantity, max_quantity, provider_service_id)
SELECT * FROM (VALUES
  ('instagram','Followers','Instagram Followers — Organic','Gradual organic-paced delivery, no drop guarantee 30d',1.9000,100,50000,NULL),
  ('instagram','Likes','Instagram Likes — Real','High quality likes, instant start',0.4500,50,20000,NULL),
  ('instagram','Views','Instagram Reels Views','Fast reel/video views',0.1200,500,1000000,NULL),
  ('tiktok','Followers','TikTok Followers','Stable followers, slow drip',2.4000,100,50000,NULL),
  ('tiktok','Views','TikTok Video Views','Instant views',0.0900,1000,1000000,NULL),
  ('youtube','Subscribers','YouTube Subscribers','Real-looking subscribers, 30d refill',12.0000,50,10000,NULL),
  ('youtube','Views','YouTube Views — Suggested','Retention views from suggested feed',3.5000,1000,500000,NULL),
  ('telegram','Members','Telegram Channel Members','Non-drop channel members',1.6000,100,50000,NULL),
  ('telegram','Views','Telegram Post Views','Instant post views',0.0500,500,500000,NULL),
  ('facebook','Likes','Facebook Page Likes','Page likes, gradual',3.2000,100,20000,NULL),
  ('facebook','Followers','Facebook Profile Followers','Profile followers',2.8000,100,20000,NULL)
) AS v(platform, category, name, description, price_per_1k, min_quantity, max_quantity, provider_service_id)
WHERE NOT EXISTS (SELECT 1 FROM services);
