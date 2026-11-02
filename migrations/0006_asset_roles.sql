ALTER TABLE assets DROP CONSTRAINT assets_role_check;

ALTER TABLE assets ADD CONSTRAINT assets_role_check CHECK (role IN (
  'current_front',
  'current_left',
  'current_right',
  'current_density',
  'current_length',
  'current_face',
  'beard',
  'inspiration',
  'preview',
  'current_side',
  'current_back'
));
