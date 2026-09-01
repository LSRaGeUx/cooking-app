CREATE TABLE "fact" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"statement" text NOT NULL,
	"polarity" text DEFAULT 'neutral' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"source_client_id" text,
	"status" text DEFAULT 'unconfirmed' NOT NULL,
	"supersedes_id" uuid,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_referenced_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "fact_category_known" CHECK ("fact"."category" in ('taste', 'organization', 'pantry_habit', 'social', 'health', 'equipment', 'technique', 'other')),
	CONSTRAINT "fact_polarity_known" CHECK ("fact"."polarity" in ('positive', 'negative', 'neutral')),
	CONSTRAINT "fact_confidence_known" CHECK ("fact"."confidence" in ('low', 'medium', 'high')),
	CONSTRAINT "fact_source_known" CHECK ("fact"."source" in ('user', 'agent', 'feedback_inference')),
	CONSTRAINT "fact_status_known" CHECK ("fact"."status" in ('unconfirmed', 'confirmed', 'retired')),
	CONSTRAINT "fact_statement_length" CHECK (char_length("fact"."statement") between 1 and 280),
	CONSTRAINT "fact_retired_at_matches_status" CHECK (("fact"."status" = 'retired') = ("fact"."retired_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "fact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_supersedes_id_fact_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."fact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fact_user_status_idx" ON "fact" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "fact_user_referenced_idx" ON "fact" USING btree ("user_id","last_referenced_at");--> statement-breakpoint
CREATE POLICY "fact_owner" ON "fact" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("fact"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("fact"."user_id" = nullif(current_setting('app.user_id', true), ''));