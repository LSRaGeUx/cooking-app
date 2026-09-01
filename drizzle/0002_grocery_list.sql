CREATE TABLE "grocery_line" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"grocery_list_id" uuid NOT NULL,
	"ingredient_id" uuid,
	"display_name" text NOT NULL,
	"quantity" numeric(12, 3),
	"unit" text,
	"aisle" text,
	"origin" text DEFAULT 'derived' NOT NULL,
	"source_entry_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"covered_by_pantry" boolean DEFAULT false NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"unmergeable_group" text,
	CONSTRAINT "grocery_line_origin_known" CHECK ("grocery_line"."origin" in ('derived', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "grocery_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "grocery_list" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grocery_list_state_known" CHECK ("grocery_list"."state" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "grocery_list" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grocery_line" ADD CONSTRAINT "grocery_line_grocery_list_id_grocery_list_id_fk" FOREIGN KEY ("grocery_list_id") REFERENCES "public"."grocery_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_line" ADD CONSTRAINT "grocery_line_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_list" ADD CONSTRAINT "grocery_list_plan_version_id_plan_version_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grocery_line_list_idx" ON "grocery_line" USING btree ("grocery_list_id","aisle","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "grocery_list_one_live_per_version_idx" ON "grocery_list" USING btree ("plan_version_id") WHERE state <> 'archived';--> statement-breakpoint
CREATE INDEX "grocery_list_user_idx" ON "grocery_list" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "grocery_line_owner" ON "grocery_line" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("grocery_line"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("grocery_line"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "grocery_list_owner" ON "grocery_list" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("grocery_list"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("grocery_list"."user_id" = nullif(current_setting('app.user_id', true), ''));