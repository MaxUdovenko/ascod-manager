# AscodCard

Create in database table named "AscodCard".

The idea is that each `directory` contains files for one `document` and this table item has metadata for this `document`

Table has fields:
- dir (contains the directory name)
- path (inner path to directory inside project)
- doc_name (name of the document)
- doc_type (type of the document: selection from list [Наказ, Розпорядження, Протокол, Доповідна записка, Лист, Договір, Угода, Меморандум]) - these items must be sorted asc.
- doc_organisation (selection from list [ДСНС, МВС, МОН, ООН, Черкаська ОДА])
- doc_span(selection from list [Внутрішній, Вихідний, Вхідний])
- doc_number
- doc_date
- doc_deadline (list of dates, one document can have multiple deadlines)
- doc_comments (comments for this document)

After creation of db table add to `Profile` page button "Додати метадані" that will show modal window with html form for filling metadata
