<?php
$lang  = isset($_GET['lang']) && $_GET['lang'] === 'es' ? 'es' : 'en';
$is_en = $lang === 'en';

$t = [
    'title'       => $is_en ? 'FAQ — Trusted Panama Stays' : 'Preguntas Frecuentes — Trusted Panama Stays',
    'description' => $is_en
        ? 'Answers to common questions about Trusted Panama Stays: legally registered accommodations, ATP verification, membership, and more.'
        : 'Respuestas a preguntas frecuentes sobre Trusted Panama Stays: hospedajes legalmente registrados, verificación ATP, membresías, y más.',
    'canonical'   => 'https://trustedpanamastays.com/faq.php?lang=' . $lang,
    'page_title'  => $is_en ? 'Frequently Asked Questions' : 'Preguntas Frecuentes',
    'subtitle'    => 'Trusted Panama Stays',
    'back_text'   => $is_en ? '← Back' : '← Volver',
    'back_href'   => $is_en ? 'index.php?lang=en' : 'index.php?lang=es',
    'lang_text'   => $is_en ? 'Español' : 'English',
    'lang_href'   => $is_en ? 'faq.php?lang=es' : 'faq.php?lang=en',
    'footer_atp'  => $is_en
        ? 'Data provided by the <a href="https://www.atp.gob.pa/industrias/hoteleros/" target="_blank">Autoridad de Turismo de Panamá (ATP)</a><br>with additional data provided by our members'
        : 'Datos proporcionados por la <a href="https://www.atp.gob.pa/industrias/hoteleros/" target="_blank">Autoridad de Turismo de Panamá (ATP)</a><br>con datos adicionales proporcionados por nuestros miembros',
];

// ── Single source of truth: every Q&A lives here once, in both languages. ──
// The visible HTML below AND the FAQPage JSON-LD schema are both generated
// from this same array, so they can never drift out of sync.
$faqs = [
    [
        'q_es' => '¿Qué es Trusted Panama Stays?',
        'a_es' => 'Trusted Panama Stays es un directorio privado e independiente de hospedajes turísticos en Panamá — no es un sitio gubernamental ni está operado por la Autoridad de Turismo de Panamá (ATP). Sin embargo, los datos básicos de cada hospedaje son los del "Reporte de Hospedajes Vigentes" de la Autoridad de Turismo de Panamá (ATP), disponible públicamente en forma de un archivo PDF. Nació de la idea de un propietario de hospedaje que buscaba una alternativa a las grandes plataformas (OTAs) que dominan las búsquedas en internet y cobran altas comisiones por reserva. No es, en primer lugar, un proyecto comercial: surgió con la intención de ofrecer esta herramienta a nuestro sector, y sus costos (tiempo, servidor, dominio, herramientas) se cubren con las membresías de apoyo. A diferencia de un listado anónimo en una plataforma comercial, cada hospedaje en TPS está basado en el registro oficial de la ATP — lo que significa que ha sido verificado públicamente y ofrece mayor confianza tanto para el viajero como para el propietario.',
        'q_en' => 'What is Trusted Panama Stays?',
        'a_en' => 'Trusted Panama Stays is a private, independent directory of tourist accommodations in Panama — it is not a government website and is not operated by Panama\'s Tourism Authority (ATP). However, the basic data for each listing comes from the ATP\'s official "Reporte de Hospedajes Vigentes" (Current Accommodations Report), a publicly available PDF. It was born from the idea of a hospitality owner looking for an alternative to the large platforms (OTAs) that dominate internet search and charge high commissions per booking. It is not, first and foremost, a commercial project: it started with the intention of offering this tool to our sector, and its costs (time, server, domain, tools) are covered by supporting memberships. Unlike an anonymous listing on a commercial platform, every accommodation on TPS is based on the official ATP registry — meaning it has been publicly verified and offers greater trust for both travelers and owners.',
    ],
    [
        'q_es' => '¿Cómo busco un hospedaje específico o por características?',
        'a_es' => 'Puede buscar por nombre (o parte del nombre), palabras en la dirección (por ejemplo, el nombre del pueblo), el número de teléfono, o el correo electrónico (o parte de este). También puede filtrar los resultados por provincia, tipo de hospedaje, o característica. Cada filtro adicional reduce los resultados a los que cumplen TODOS los criterios — si obtiene muy pocos resultados, intente usar menos filtros. Búsquedas especiales: #12345 (o simplemente 12345) busca por número de listado; =member muestra todos los miembros (de prueba y de apoyo) de la comunidad TPS; =apatel muestra los miembros de APATEL en este directorio. Sin ningún término de búsqueda, el directorio muestra varios "Hospedajes Destacados".',
        'q_en' => 'How do I search for a specific rental or by characteristics?',
        'a_en' => 'You can search by name (or part of the name), words in the address (such as the town name), the phone number, or the email address (or part of it). You can also filter results by province, rental type, or feature. Each additional filter narrows results to those matching ALL selected criteria — if you get too few results, try using fewer filters. Special searches: #12345 (or simply 12345) searches by listing number; =member shows all members (trial and supporting) of the TPS community; =apatel shows APATEL members in this directory. With no search term, the directory shows several "Featured Accommodations".',
    ],
    [
        'q_es' => '¿Cómo me pongo en contacto con un hospedaje?',
        'a_es' => 'Cada listado incluye los botones disponibles según la información existente: llamar, enviar correo, enviar WhatsApp, o buscarlo en Google Maps. Por ejemplo, si el hospedaje no tiene un número móvil, no habrá botón de WhatsApp; si no hay ningún teléfono, no habrá botón de llamada. El resultado en Google Maps depende de la información disponible. A menudo, el nombre del hospedaje junto con la provincia es suficiente — estos son los únicos datos disponibles en el registro oficial de la ATP, en el cual se basa este directorio. Los miembros de TPS pueden agregar más información (por ejemplo, una dirección detallada, el nombre del pueblo o barrio, o un punto de referencia cercano) para que Google y los usuarios los encuentren más fácilmente.',
        'q_en' => 'How do I get in touch with a rental?',
        'a_en' => 'Every listing includes whichever buttons are available based on the information on file: call, send an email, send a WhatsApp message, or look it up on Google Maps. For example, if the property has no mobile number, there is no WhatsApp button; if there is no phone number at all, there is no call button. The Google Maps result depends on the information available. Often, the property\'s name together with the province is enough — these are the only data available in the official ATP registry, on which this directory is based. TPS members can add more information (such as a detailed address, the name of the town or neighborhood, or a nearby landmark) so Google and users can find them more easily.',
    ],
    [
        'q_es' => '¿Cómo encuentro más información sobre un hospedaje?',
        'a_es' => 'La información básica de este directorio proviene del reporte oficial de la ATP, que generalmente incluye solo el nombre del hospedaje, su provincia, el tipo de hospedaje, y un correo y/o teléfono — sin dirección ni nombre de pueblo. Esta información básica es suficiente para contactar al hospedaje. Los miembros de TPS pueden crear su propia página dentro del directorio con información mucho más detallada: fotos, descripción, enlaces a su sitio web o página de pago, y características particulares. Puede acceder a esta información haciendo clic en el botón "Acceso".',
        'q_en' => 'How do I find more information about a rental?',
        'a_en' => 'The basic information in this directory comes from the official ATP report, which generally includes only the property\'s name, its province, the rental type, and an email and/or phone number — without an address or town name. This basic information is enough to contact the property. TPS members can create their own page within the directory with much more detailed information: photos, a description, links to their website or booking page, and specific features. You can access this information by clicking the "Access" button.',
    ],
    [
        'q_es' => '¿Cómo puedo registrar mi hospedaje en Trusted Panama Stays?',
        'a_es' => 'Si su hospedaje está registrado ante la ATP, probablemente ya aparece en nuestro directorio. Visite la página "Registre su hospedaje" para solicitar su membresía gratuita de prueba (30 días) o una membresía de apoyo. Si su hospedaje no está registrado ante la ATP pero cuenta con un Aviso de Operación vigente (registro ante el MiCI), también puede solicitar su membresía — indíquelo en el formulario de solicitud.',
        'q_en' => 'How can I register my property with Trusted Panama Stays?',
        'a_en' => 'If your property is registered with the ATP, it likely already appears in our directory. Visit the "Register your property" page to apply for a free 30-day trial membership or a supporting membership. If your property is not registered with the ATP but holds a valid Aviso de Operación (MiCI registration), you can also apply — just indicate this on the application form.',
    ],
    [
        'q_es' => '¿Es obligatorio estar registrado ante la ATP para ser miembro?',
        'a_es' => 'No necesariamente. Aceptamos hospedajes con Aviso de Operación vigente (registro MiCI) aunque no aparezcan en el reporte de la ATP. Sin embargo, solo se listan hospedajes con registro legal vigente — no incluimos hospedajes informales.',
        'q_en' => 'Is ATP registration required to become a member?',
        'a_en' => 'Not necessarily. We accept properties with a valid Aviso de Operación (MiCI registration) even if they don\'t appear in the ATP report. However, we only list properties with valid legal registration — we do not include informal rentals.',
    ],
    [
        'q_es' => '¿Cuánto cuesta una membresía de apoyo?',
        'a_es' => 'Ofrecemos una prueba gratuita de 30 días sin compromiso. Después de la prueba, la membresía de apoyo cuesta $24/año (o $45 por 2 años) + ITBMS — un cargo fijo anual, sin comisión sobre sus reservas, que ayuda a cubrir los costos de mantener este directorio.',
        'q_en' => 'How much does a supporting membership cost?',
        'a_en' => 'We offer a free 30-day trial with no commitment. After the trial, a supporting membership costs $24/year (or $45 for 2 years) + ITBMS — a fixed annual fee, with no commission on your bookings, that helps cover the cost of maintaining this directory.',
    ],
    [
        'q_es' => '¿Cómo se verifica la información de los hospedajes?',
        'a_es' => 'La información básica proviene directamente del registro oficial de la ATP. Al solicitar una membresía, verificamos los documentos del solicitante (Aviso de Operación y cédula) para confirmar que corresponde al hospedaje en cuestión.',
        'q_en' => 'How is listing information verified?',
        'a_en' => 'The basic information comes directly from the official ATP registry. When someone applies for membership, we verify the applicant\'s documents (Aviso de Operación and ID) to confirm they correspond to the property in question.',
    ],
    [
        'q_es' => '¿Qué hago si la información de un listado es incorrecta?',
        'a_es' => 'Escríbanos a info@trustedpanamastays.com indicando el nombre o número del hospedaje y el error encontrado. Si usted es el propietario, puede solicitar acceso a su listado para corregir la información usted mismo.',
        'q_en' => 'What should I do if a listing\'s information is incorrect?',
        'a_en' => 'Write to us at info@trustedpanamastays.com with the property\'s name or listing number and the error you found. If you are the owner, you can request access to your listing to correct the information yourself.',
    ],
    [
        'q_es' => '¿Cómo se clasifican los "Hospedajes Destacados"?',
        'a_es' => 'Los hospedajes destacados se ordenan según criterios objetivos y transparentes: 1) Los miembros de apoyo se muestran antes que los miembros de prueba. 2) Entre miembros del mismo tipo, los más antiguos se muestran primero. 3) Los miembros que ofrecen más información (descripción, fotos, dirección completa, características) se muestran antes que los que no lo hacen. Estos criterios podrían cambiar en el futuro, especialmente a medida que más miembros completen su información y el orden de antigüedad se vuelva menos relevante.',
        'q_en' => 'How are "Featured Accommodations" ranked?',
        'a_en' => 'Featured accommodations are ranked using objective, transparent criteria: 1) Supporting members are shown before trial members. 2) Among members of the same type, the longest-standing members are shown first. 3) Members who provide more information (description, photos, full address, features) are shown before those who don\'t. These criteria may change in the future, particularly as more members complete their information and the seniority order becomes less relevant.',
    ],
    [
        'q_es' => '¿TPS tiene alguna relación con Airbnb o Booking.com?',
        'a_es' => 'No. Trusted Panama Stays es un directorio completamente independiente, sin ninguna relación con Airbnb, Booking.com u otras plataformas de reservas (OTAs). No procesamos reservas ni pagos entre huéspedes y propietarios — solo facilitamos el contacto directo.',
        'q_en' => 'Is TPS affiliated with Airbnb or Booking.com?',
        'a_en' => 'No. Trusted Panama Stays is a completely independent directory, with no relationship to Airbnb, Booking.com, or other booking platforms (OTAs). We do not process bookings or payments between guests and owners — we only facilitate direct contact.',
    ],
    [
        'q_es' => '¿TPS cobra alguna comisión por reservar a través del directorio?',
        'a_es' => 'No. TPS no cobra comisión alguna a huéspedes ni a propietarios por poner en contacto. El contacto y la reserva se realizan directamente entre el huésped y el hospedaje, sin intermediarios ni cargos adicionales.',
        'q_en' => 'Does TPS charge any commission for bookings made through the directory?',
        'a_en' => 'No. TPS does not charge any commission to guests or owners for putting them in contact. Contact and booking happen directly between the guest and the property, with no intermediaries or additional charges.',
    ],
    [
        'q_es' => '¿Qué tipos de hospedajes se pueden encontrar en Trusted Panama Stays?',
        'a_es' => 'El directorio incluye hoteles, aparthoteles, hostales, hostales familiares, apartamentos, alquileres vacacionales, cabañas, sitios de acampar y albergues — todos legalmente registrados en Panamá.',
        'q_en' => 'What types of accommodations can be found on Trusted Panama Stays?',
        'a_en' => 'The directory includes hotels, aparthotels, hostels, family hostels, apartments, vacation rentals, cabins, campsites, and lodges — all legally registered in Panama.',
    ],
    [
        'q_es' => '¿En qué provincias de Panamá tiene cobertura Trusted Panama Stays?',
        'a_es' => 'TPS cubre todas las provincias de Panamá, incluyendo Panamá, Panamá Oeste, Chiriquí, Bocas del Toro, Coclé, Colón, Veraguas, Los Santos, Herrera y Darién, según los hospedajes registrados ante la ATP en cada región.',
        'q_en' => 'Which provinces of Panama does Trusted Panama Stays cover?',
        'a_en' => 'TPS covers every province of Panama, including Panamá, Panamá Oeste, Chiriquí, Bocas del Toro, Coclé, Colón, Veraguas, Los Santos, Herrera, and Darién, based on the accommodations registered with the ATP in each region.',
    ],
    [
        'q_es' => '¿Qué significa "APATEL" en el directorio?',
        'a_es' => 'APATEL es la Asociación Panameña de Hoteles. Los hospedajes marcados con la insignia "APATEL" en el directorio son miembros de esta asociación.',
        'q_en' => 'What does "APATEL" mean in the directory?',
        'a_en' => 'APATEL is the Panamanian Hotel Association (Asociación Panameña de Hoteles). Properties marked with the "APATEL" badge in the directory are members of this association.',
    ],
    [
        'q_es' => '¿Cómo sé si un alquiler vacacional en Panamá es legal?',
        'a_es' => 'Un hospedaje legal en Panamá debe contar con un Aviso de Operación vigente y, en el caso de hospedajes turísticos, generalmente aparece en el "Reporte de Hospedajes Vigentes" de la ATP. Trusted Panama Stays solo incluye hospedajes que cumplen con este requisito — a diferencia de muchos alquileres informales que se anuncian en plataformas donde no se verifica el registro legal.',
        'q_en' => 'How do I know if a vacation rental in Panama is legal?',
        'a_en' => 'A legal accommodation in Panama must hold a valid Aviso de Operación and, in the case of tourist accommodations, generally appears in the ATP\'s "Reporte de Hospedajes Vigentes" (Current Accommodations Report). Trusted Panama Stays only includes properties that meet this requirement — unlike many informal rentals advertised on platforms where legal registration is not verified.',
    ],
    [
        'q_es' => '¿Usar Trusted Panama Stays tiene algún costo para el viajero?',
        'a_es' => 'No. Buscar y contactar hospedajes en Trusted Panama Stays es completamente gratuito para el viajero. El costo de membresía aplica únicamente a los propietarios que desean una página de perfil ampliada.',
        'q_en' => 'Is there any cost for travelers to use Trusted Panama Stays?',
        'a_en' => 'No. Searching and contacting accommodations on Trusted Panama Stays is completely free for travelers. The membership fee applies only to owners who want an expanded profile page.',
    ],
];

// Build the FAQPage schema from the same array driving the visible content below
$schemaItems = array_map(function($f) use ($is_en) {
    return [
        '@type' => 'Question',
        'name'  => $is_en ? $f['q_en'] : $f['q_es'],
        'acceptedAnswer' => [
            '@type' => 'Answer',
            'text'  => $is_en ? $f['a_en'] : $f['a_es'],
        ],
    ];
}, $faqs);

$faqSchema = [
    '@context'   => 'https://schema.org',
    '@type'      => 'FAQPage',
    'mainEntity' => $schemaItems,
];
?>
<!DOCTYPE html>
<html lang="<?= $lang ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= $t['title'] ?></title>
    <meta name="description" content="<?= htmlspecialchars($t['description']) ?>">
    <link rel="canonical" href="<?= $t['canonical'] ?>">
    <link rel="alternate" hreflang="es" href="https://trustedpanamastays.com/faq.php?lang=es">
    <link rel="alternate" hreflang="en" href="https://trustedpanamastays.com/faq.php?lang=en">
    <link rel="alternate" hreflang="x-default" href="https://trustedpanamastays.com/faq.php?lang=es">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <script type="application/ld+json">
<?= json_encode($faqSchema, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) ?>
    </script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8f9fa; color: #111; line-height: 1.7; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }

        header {
            background: linear-gradient(135deg, #005ca9, #00a859);
            color: white; padding: 1.2rem 1.8rem; border-radius: 10px;
            margin-bottom: 2rem; display: flex; align-items: center;
            justify-content: space-between; flex-wrap: wrap; gap: 0.75rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .header-left { display: flex; align-items: center; gap: 12px; }
        .header-logo { width: 52px; height: 52px; }
        .header-left h1 { font-size: 1.4rem; font-weight: 700; }
        .header-left p  { font-size: 0.82rem; opacity: 0.85; }
        .header-right { display: flex; gap: 8px; align-items: center; }

        .lang-toggle, .back-link {
            display: inline-flex; align-items: center; gap: 6px;
            background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.4);
            border-radius: 20px; padding: 5px 14px; text-decoration: none;
            color: white; font-size: 0.82rem; font-weight: 600;
        }
        .lang-toggle:hover, .back-link:hover { background: rgba(255,255,255,0.28); }

        .content {
            background: white; border-radius: 12px;
            padding: 2.5rem; box-shadow: 0 2px 20px rgba(0,0,0,0.08);
            margin-bottom: 1.5rem;
        }

        .faq-item { margin-bottom: 1.6rem; }
        .faq-item:last-child { margin-bottom: 0; }
        .faq-q { font-size: 1.05rem; font-weight: 700; color: #005ca9; margin-bottom: 0.4rem; }
        .faq-a { color: #444; }

        footer { background: #2c3e50; color: #ccc; border-radius: 10px; padding: 1.2rem 1.5rem; margin-top: 1.5rem; text-align: center; font-size: 0.85rem; line-height: 1.8; }
        footer a { color: #7ec8e3; text-decoration: none; }
        footer a:hover { text-decoration: underline; }
    </style>
</head>
<body>
<div class="container">
    <header>
        <div class="header-left">
            <svg class="header-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 260">
                <rect x="30" y="130" width="100" height="62" fill="white"/>
                <rect x="130" y="130" width="100" height="62" fill="#cc0000"/>
                <rect x="30" y="192" width="100" height="62" fill="#1a3a6b"/>
                <rect x="130" y="192" width="100" height="62" fill="white"/>
                <rect x="30" y="130" width="200" height="124" fill="none" stroke="white" stroke-width="2"/>
                <polygon points="80,147 82.5,155 91,155 84,160 86.5,168 80,163 73.5,168 76,160 69,155 77.5,155" fill="#1a3a6b"/>
                <polygon points="180,209 182.5,217 191,217 184,222 186.5,230 180,225 173.5,230 176,222 169,217 177.5,217" fill="#cc0000"/>
                <polyline points="5,128 130,16 255,128" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M54,138 L98,246 L218,26" fill="none" stroke="#FFD700" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div>
                <h1><?= $t['page_title'] ?></h1>
                <p style="color:white;"><?= $t['subtitle'] ?></p>
            </div>
        </div>
        <div class="header-right">
            <a href="<?= $t['back_href'] ?>" class="back-link"><?= $t['back_text'] ?></a>
            <a href="<?= $t['lang_href'] ?>" class="lang-toggle"><?= $t['lang_text'] ?></a>
        </div>
    </header>

    <div class="content">
        <?php foreach ($faqs as $f): ?>
        <div class="faq-item">
            <div class="faq-q"><?= $is_en ? htmlspecialchars($f['q_en']) : htmlspecialchars($f['q_es']) ?></div>
            <div class="faq-a"><?= $is_en ? htmlspecialchars($f['a_en']) : htmlspecialchars($f['a_es']) ?></div>
        </div>
        <?php endforeach; ?>
    </div>

    <footer>
        <p style="font-size:0.8rem;"><?= $t['footer_atp'] ?></p>
        <p style="margin-top:0.8rem;">
            Trusted Panama Stays · Tuscany Real Estates SA · RUC 1401220-1-627960 DV21<br>
            <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a>
        </p>
    </footer>
</div>
</body>
</html>
