<?php
/**
 * Shared site footer. Include just before the closing </div> of .container.
 * Required in scope: $is_en (already set by every page)
 */
?>
    <footer>
        <p style="font-size:0.8rem;"><?= $is_en ? 'Based on public data from the' : 'Basado en datos públicos de la' ?> <a href="https://www.atp.gob.pa/industrias/hoteleros/" target="_blank">Autoridad de Turismo de Panamá (ATP)</a><br><?= $is_en ? 'with additional data provided by our members' : 'con datos adicionales proporcionados por nuestros miembros' ?></p>
        <p style="margin-top:0.8rem;">
            <?= $is_en ? 'Trusted Panama Stays is owned by Tuscany Real Estates SA' : 'Trusted Panama Stays es propiedad de Tuscany Real Estates SA' ?><br>
            RUC 1401220-1-627960 DV21<br>
            <a href="mailto:info@trustedpanamastays.com">info@trustedpanamastays.com</a>
        </p>
    </footer>
