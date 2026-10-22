SELECT
  (SELECT COUNT(*) FROM profiles WHERE email LIKE '%@example.com') AS testprofiles,
  (SELECT COUNT(*) FROM posts WHERE author_email LIKE '%@example.com') AS testposts,
  (SELECT COUNT(*) FROM notifications) AS notifs,
  (SELECT COUNT(*) FROM posts) AS allposts,
  (SELECT COUNT(*) FROM profiles) AS allprofiles;
