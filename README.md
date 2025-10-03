This project is an attempt to transform the publicly provided PDF list of registered touristic rentals in Panama into a searchable app that allows to find the property on Google Maps, and to contact them with a click, either via WhatsApp or vie email.
The main problem is formatting the PDF list into readable data.
The decoded data represent the PDF tables not as a congrunent collection of lines where each line represents one property. Instead they come as  series of columns which have to be separated and then analyzed to identify the elements of the corresponding rows. 
The problem is that sometimes elements of a column are empty, and in other cases, one item (e.g. a long name) is spread over two column elements.
Still trying to find a better decoding method for the PDF file.
Unfortunately, the published PDF is the only publicly accessable source, and there is no public access to the underlying data base.

Now trying differen pdf parsers
