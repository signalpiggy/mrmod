-- Add nu.fi to the knowledge base crawl if an admin already saved custom crawl settings.
UPDATE "settings" SET "value" = "value" || '["nu.fi"]'::jsonb, "updated_at" = now(), "updated_by" = 'migration'
WHERE "key" = 'kbAllowedHosts' AND jsonb_typeof("value") = 'array' AND NOT ("value" ? 'nu.fi');
--> statement-breakpoint
UPDATE "settings" SET "value" = "value" || '["https://nu.fi/", "https://nu.fi/chains/support"]'::jsonb, "updated_at" = now(), "updated_by" = 'migration'
WHERE "key" = 'kbStartUrls' AND jsonb_typeof("value") = 'array' AND NOT ("value" ? 'https://nu.fi/');
