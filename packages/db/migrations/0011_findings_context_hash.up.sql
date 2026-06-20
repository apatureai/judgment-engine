-- Context-block reference on findings (#43): the deterministic content hash (#63)
-- of the context block the finding was produced under, so the preference export
-- can join (image, context, finding, verdict). The context-block bytes live as an
-- object-storage artifact referenced by this hash (DVC export #75).
ALTER TABLE findings ADD COLUMN context_hash text;
