CREATE TABLE "pantry_item" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"ingredient_id" uuid,
	"name" text NOT NULL,
	"quantity_note" text,
	"expires_on" date,
	"source" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pantry_item_kind_known" CHECK ("pantry_item"."kind" in ('staple', 'use_soon')),
	CONSTRAINT "pantry_item_source_known" CHECK ("pantry_item"."source" in ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "pantry_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pantry_item_user_kind_idx" ON "pantry_item" USING btree ("user_id","kind");--> statement-breakpoint
CREATE POLICY "pantry_item_owner" ON "pantry_item" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("pantry_item"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("pantry_item"."user_id" = nullif(current_setting('app.user_id', true), ''));