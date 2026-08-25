# Calendar

At the side menu, above the "Каталоги" item put item "Календар"

All functionality and index page for calendar save to `src/calendar`

As we use AdminLTE get sample for calendar page from this url
<https://adminlte.io/themes/v4/pages/calendar.html> or from github of AdminLTE if you need. At calendar page do not put `Draggable events` section, only calendar.

to database table `AscodCard` ad field `brief_desc`, add this field for all forms where created or edited data from this table

to database table `AscodCard` ad field `doc_status` with values for selection ("на виконанні", "виконано", "опрацювати"), add this field for all forms where created or edited data from this table

On calendar page show events from database that has `doc_deadline` value:
- red color for `doc_organisation` ДСНС
- green color for `doc_organisation` НУЦЗУ
- yellow color for `doc_organisation` МОН
- blue color for other `doc_organisation`
- as event text show `brief_desc` field
- if `doc_status` value == "на виконанні" to the start of the event text add icon with this mark "!"
