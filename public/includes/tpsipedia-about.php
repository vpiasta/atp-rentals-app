<?php
/**
 * "About TPSipedia" content (EN + ES), shown by tpsipedia.php?page=about.
 * Also read by sitemap.php and indexnow-ping.php for the last-modified date.
 *
 * When you change the text below, also change TPSI_ABOUT_UPDATED to today's date,
 * so the page shows the new date and IndexNow resubmits it.
 */
if (!defined('TPSI_ABOUT_UPDATED')) define('TPSI_ABOUT_UPDATED', '2026-10-29');
if (!defined('TPSI_AUTHOR_NAME'))   define('TPSI_AUTHOR_NAME', 'Volker Piasta');        // plain name (structured data)
if (!defined('TPSI_AUTHOR_SHOWN'))  define('TPSI_AUTHOR_SHOWN', 'Ing. Volker Piasta');  // name with title as shown on pages

function tpsi_about_content($lang) {
    if ($lang === 'es') return [
        'title'    => 'Acerca de TPSipedia: quién la escribe y cómo se verifica',
        'meta'     => 'Quién escribe y verifica TPSipedia, cómo se comprueba cada afirmación legal contra los textos oficiales, cómo corregimos errores y quién publica el sitio.',
        'h1'       => 'Acerca de TPSipedia',
        'lead'     => 'Quién escribe las páginas, cómo se verifican y quién las publica.',
        'body'     => <<<'HTML'
<h2>Qué es TPSipedia</h2>
<p>TPSipedia es una colección de páginas breves de preguntas y respuestas sobre las normas que aplican a los alquileres turísticos y de corta estancia en Panamá. Cada página da primero la respuesta, luego la base legal con los artículos exactos y, al final, los enlaces a los textos oficiales.</p>

<h2>Quién escribe y verifica las páginas</h2>
<p>Las páginas las escribe y mantiene el Ing. Volker Piasta (Dipl.-Ing., Technische Universität Berlin), gerente general de Aparthotel Boquete, un hospedaje registrado ante la Autoridad de Turismo de Panamá (ATP) en Boquete, Chiriquí. Los borradores se preparan con ayuda de herramientas de inteligencia artificial; cada afirmación legal se verifica a mano contra el texto oficial antes de publicarse.</p>
<p>No somos abogados. Cuando un abogado o contador público autorizado publica un análisis propio sobre un tema, lo enlazamos como fuente.</p>

<h2>Cómo verificamos</h2>
<ul>
<li><strong>Textos oficiales primero.</strong> Cada afirmación sobre lo que dice una ley, un decreto o un proyecto de ley se comprueba contra el texto oficial (Gaceta Oficial, textos y actas de la Asamblea Nacional, publicaciones de la ATP) y se enlaza en "Textos legales primarios".</li>
<li><strong>La prensa, aparte.</strong> Los artículos de prensa se listan por separado y solo se usan para hechos que los textos oficiales no cubren, por ejemplo la fecha en que se presentó un proyecto. Nunca para decir lo que establece una norma.</li>
<li><strong>Proyectos de ley como propuestas.</strong> Un proyecto se describe como lo que propone, con su estado y la fecha en que ese estado se verificó por última vez.</li>
<li><strong>Cifras verificables.</strong> El número de hospedajes registrados se toma en vivo del propio reporte de hospedajes vigentes de la ATP, enlazado en la página para que cualquiera pueda comprobarlo. Las cifras de mercado solo se citan de fuentes oficiales y siempre con su origen.</li>
<li><strong>Tono neutral.</strong> Las páginas dicen lo que establecen los textos, no lo que pensamos de ellos. Las opiniones van en el blog.</li>
</ul>

<h2>Correcciones</h2>
<p>Si encuentra un error, escríbanos a <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a> indicando la página y, si es posible, la fuente. Lo verificamos contra el texto oficial; si la página está equivocada, la corregimos y cambia su fecha de "Actualizado".</p>

<h2>Quién publica TPSipedia</h2>
<p>TPSipedia forma parte de Trusted Panama Stays (TrustedPanamaStays.com), un directorio que solo incluye hospedajes registrados ante la ATP o con aviso de operación del MICI. El sitio es propiedad de Tuscany Real Estates S.A., que también opera Aparthotel Boquete. El Ing. Piasta es miembro de la Asociación Panameña de Hoteles (APATEL).</p>
<p>Aparecer en el directorio es gratis para todo hospedaje registrado; los propietarios pueden pagar una membresía para agregar fotos, descripciones y datos de contacto. Las membresías no influyen en el contenido de TPSipedia. Ninguna plataforma, asociación ni entidad pública paga ni revisa estas páginas.</p>

<h2>Lo que TPSipedia no es</h2>
<p>TPSipedia explica la ley en términos generales y no es asesoría legal ni fiscal. Para su caso particular, consulte a un abogado o contador público autorizado.</p>
HTML
    ];
    return [
        'title'    => 'About TPSipedia: who writes it and how it is checked',
        'meta'     => 'Who writes and checks TPSipedia, how every legal statement is verified against the official texts, how errors are corrected and who publishes the site.',
        'h1'       => 'About TPSipedia',
        'lead'     => 'Who writes the pages, how they are checked, and who publishes them.',
        'body'     => <<<'HTML'
<h2>What TPSipedia is</h2>
<p>TPSipedia is a collection of short question-and-answer pages on the rules that apply to tourist and short-term rentals in Panama. Each page gives the answer first, then the legal basis with the exact articles, and finally links to the official texts.</p>

<h2>Who writes and checks the pages</h2>
<p>The pages are written and maintained by Ing. Volker Piasta (Dipl.-Ing., Technische Universität Berlin), general manager of Aparthotel Boquete, a lodging registered with the Autoridad de Turismo de Panamá (ATP) in Boquete, Chiriquí. Drafts are prepared with the help of AI tools; every legal statement is checked by hand against the official text before it is published.</p>
<p>We are not lawyers. When a lawyer or certified public accountant publishes their own analysis of a topic, we link it as a source.</p>

<h2>How we check</h2>
<ul>
<li><strong>Official texts first.</strong> Every statement about what a law, decree or bill says is checked against the official text (Gaceta Oficial, National Assembly bill texts and minutes, ATP publications) and linked under "Primary legal texts".</li>
<li><strong>Press kept separate.</strong> Press articles are listed separately and used only for facts the official texts do not cover, such as the date a bill was presented. Never for what a rule says.</li>
<li><strong>Bills as proposals.</strong> A bill is described as what it proposes, with its status and the date that status was last verified.</li>
<li><strong>Numbers you can check.</strong> The number of registered lodgings is taken live from the ATP's own report of licensed lodgings, linked on the page so anyone can verify it. Market figures are only quoted from official sources, always with their origin.</li>
<li><strong>Neutral tone.</strong> The pages say what the texts establish, not what we think of them. Opinions belong on the blog.</li>
</ul>

<h2>Corrections</h2>
<p>If you find an error, write to <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a> with the page and, if possible, the source. We check it against the official text; if the page is wrong, we correct it and its "Updated" date changes.</p>

<h2>Who publishes TPSipedia</h2>
<p>TPSipedia is part of Trusted Panama Stays (TrustedPanamaStays.com), a directory that only lists lodgings registered with the ATP or holding a MICI aviso de operación. The site is owned by Tuscany Real Estates S.A., which also operates Aparthotel Boquete. Ing. Piasta is a member of the Panamanian Hotel Association (APATEL).</p>
<p>Being listed in the directory is free for every registered lodging; owners can pay for a membership to add photos, descriptions and contact details. Memberships have no influence on TPSipedia content. No platform, association or public body pays for or reviews these pages.</p>

<h2>What TPSipedia is not</h2>
<p>TPSipedia explains the law in general terms and is not legal or tax advice. For your specific case, consult a lawyer or certified public accountant.</p>
HTML
    ];
}
