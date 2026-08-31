CREATE TABLE "agent_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"oauth_client_id" text,
	"tool_name" text NOT NULL,
	"direction" text NOT NULL,
	"payload_summary" jsonb,
	"result" text NOT NULL,
	"rejection_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "agent_activity_user_created_idx" ON "agent_activity" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "agent_activity_owner" ON "agent_activity" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("agent_activity"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("agent_activity"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);