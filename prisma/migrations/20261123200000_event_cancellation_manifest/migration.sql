BEGIN;
CREATE TABLE staff_admin_event_cancellations (
 "operationId" UUID PRIMARY KEY REFERENCES staff_admin_operations(id),
 "eventId" TEXT NOT NULL UNIQUE,
 "eventTitle" TEXT NOT NULL,
 members JSONB NOT NULL CHECK (jsonb_typeof(members)='array'),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION preserve_corporate_cancellation_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'The original reviewed event cancellation manifest is immutable'; END $$;
CREATE TRIGGER preserve_corporate_cancellation_manifest BEFORE UPDATE OR DELETE ON staff_admin_event_cancellations FOR EACH ROW EXECUTE FUNCTION preserve_corporate_cancellation_manifest();
CREATE OR REPLACE FUNCTION preserve_corporate_refund_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.operation IN ('admin_refund_ticket','admin_cancel_event') THEN RAISE EXCEPTION 'Original corporate financial intent is immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
COMMIT;
