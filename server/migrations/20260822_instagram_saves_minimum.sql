-- Route the Instagram bundle's saves item to the imported min-10 service on
-- the same provider account. The old provider service 2903 requires 100.
WITH replacement AS (
  SELECT s.id
    FROM services s
    JOIN service_provider_mapping m
      ON m.service_id = s.id
     AND m.is_active = true
    JOIN provider_accounts pa
      ON pa.id = m.provider_account_id
     AND pa.is_active = true
   WHERE s.is_active = true
     AND s.provider_service_id = '2893'
     AND s.min_quantity = 10
     AND LOWER(pa.name) = 'apichp'
   ORDER BY m.sort_order, s.id
   LIMIT 1
)
UPDATE bundle_items bi
   SET service_id = replacement.id
  FROM engagement_bundles b, replacement
 WHERE b.id = bi.bundle_id
   AND LOWER(b.platform) = 'instagram'
   AND bi.engagement_type = 'saves'
   AND EXISTS (
     SELECT 1
       FROM services current_service
      WHERE current_service.id = bi.service_id
        AND current_service.provider_service_id = '2903'
        AND current_service.min_quantity = 100
   );