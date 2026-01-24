- [ ] make the reactions A LOT more efficient by calculating the counts in sql rather than js
- [-] change the api to be more like this: https://ding.bar/c/379
- [x] instead of #pub, *pri, @usr, let's consider this for readable comma sep url:
      `tag:pub,org:pri,usr:usr,www:example.com`, which we can convert to query string like "#pub *pri @usr ~example.com
      lorem ipsum"
- [ ] add to welcome guide: github source
- [ ] index pages (and coments): every post should have a square thumbnail, which is either main extracted image, or
      screenshot of site
- [ ] detail pages: show big square and thumbnail squares underneath for all attachments.
- [ ] create curation bots that post top tags, users, etc
- [x] we need a site/url/host label like ~taylor.town or /taylor.town
- [ ] if you hit "reply" and you're not logged in it should prompt to create new account
- [ ] figure out adding/managing orgs. /o for creating org? /o for editing/moderating the org and adding users?
- [ ] show better titles for search pages, e.g. "#foo" if just searching the foo tag. add actions like "add to
      homepage". "*foo" should also show special info
- [ ] the searchbar should always show the full query, including "baz +#foo -#bar"
- [ ] create a "bestof" bot that collects and summarizes stuff from around the site. they're just normal posts like any
      other. don't define any special rec engines or discovery in the database.
- [ ] preview link/image on hover
- [ ] add related tags and posts to footer (backlinks)
- [ ] add mod/flagging mechanism by commenting "spam" or "abuse"
- [ ] prettier signin/signup/forgot-password ui. probably form and links on /u
- [ ] bubbletea cli/tui
- [ ] launch
- [ ] bare links should open external site in new tab
- [ ] find specific discord/slack/reddit/zulip/discourse communities (esp. mods) that want to try ding out
- [ ] publish guides on how to move community archives over and/or livesync from discord/slack/etc
- [ ] add shortcuts for post/reply types: start huddle/room/livestream, upload file, record audio/video, draw picture,
      remix
