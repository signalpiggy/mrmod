CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text,
	"action" text NOT NULL,
	"target" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"message_id" text NOT NULL,
	"author_id" text NOT NULL,
	"author_tag" text,
	"content" text,
	"content_hash" text NOT NULL,
	"signals" jsonb NOT NULL,
	"risk_score" real NOT NULL,
	"moderation_flagged" boolean DEFAULT false NOT NULL,
	"moderation_scores" jsonb,
	"judged" boolean DEFAULT false NOT NULL,
	"verdict" jsonb,
	"judge_model" text,
	"judge_latency_ms" integer,
	"judge_input_tokens" integer,
	"judge_output_tokens" integer,
	"rule_id" text,
	"mode" text,
	"planned_action" jsonb,
	"executed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"label" text,
	"labeled_by" text,
	"labeled_at" timestamp with time zone,
	"sampled" boolean DEFAULT false NOT NULL,
	"modlog_message_id" text
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_pages" (
	"url" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"answerable" boolean NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"mode" text DEFAULT 'shadow' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"definition" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_url_kb_pages_url_fk" FOREIGN KEY ("url") REFERENCES "public"."kb_pages"("url") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_created_idx" ON "decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "decisions_author_idx" ON "decisions" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "decisions_hash_idx" ON "decisions" USING btree ("content_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_message_idx" ON "decisions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "kb_chunks_embedding_idx" ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);