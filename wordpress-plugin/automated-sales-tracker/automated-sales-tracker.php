<?php
/**
 * Plugin Name:       Automated Sales — Prospect Journey Tracker
 * Description:       Loads the Automated Sales journey-tracking snippet on every page, so website visits and form-email captures feed into your Pipedrive attribution data. No code editing required — paste in the three values printed by "npm run add-tenant" and you're done.
 * Version:            1.0.0
 * Requires at least:  5.8
 * Requires PHP:       7.2
 * Author:             Automated Sales
 * License:            GPL-2.0-or-later
 * License URI:        https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:        automated-sales-tracker
 */

// Exit if accessed directly — this file must only ever run inside WordPress.
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'AS_TRACKER_OPTION', 'as_tracker_settings' );
define( 'AS_TRACKER_VERSION', '1.0.0' );

/**
 * Settings: API URL, track key, and the snippet's script URL — the exact
 * three values `npm run add-tenant` prints under "1. WEBSITE" for this
 * client. Stored as one array option so a single get_option() call covers
 * everything the front-end enqueue needs.
 */
function as_tracker_default_settings() {
	return array(
		'api_url'    => '',
		'track_key'  => '',
		'script_url' => '',
	);
}

function as_tracker_get_settings() {
	$saved = get_option( AS_TRACKER_OPTION, array() );
	return wp_parse_args( $saved, as_tracker_default_settings() );
}

function as_tracker_is_configured() {
	$settings = as_tracker_get_settings();
	return ! empty( $settings['api_url'] ) && ! empty( $settings['track_key'] ) && ! empty( $settings['script_url'] );
}

/**
 * Settings page under Settings > Automated Sales Tracker.
 */
add_action( 'admin_menu', 'as_tracker_add_settings_page' );
function as_tracker_add_settings_page() {
	add_options_page(
		__( 'Automated Sales Tracker', 'automated-sales-tracker' ),
		__( 'Automated Sales Tracker', 'automated-sales-tracker' ),
		'manage_options',
		'automated-sales-tracker',
		'as_tracker_render_settings_page'
	);
}

add_action( 'admin_init', 'as_tracker_register_settings' );
function as_tracker_register_settings() {
	register_setting(
		'as_tracker_settings_group',
		AS_TRACKER_OPTION,
		array(
			'type'              => 'array',
			'sanitize_callback' => 'as_tracker_sanitize_settings',
			'default'           => as_tracker_default_settings(),
		)
	);

	add_settings_section(
		'as_tracker_main_section',
		__( 'Client configuration', 'automated-sales-tracker' ),
		function () {
			echo '<p>' . esc_html__(
				'Paste in the three values printed under "1. WEBSITE" when this client was set up (npm run add-tenant). All three are required for tracking to load.',
				'automated-sales-tracker'
			) . '</p>';
		},
		'automated-sales-tracker'
	);

	add_settings_field(
		'api_url',
		__( 'Tracker API URL', 'automated-sales-tracker' ),
		'as_tracker_field_api_url',
		'automated-sales-tracker',
		'as_tracker_main_section'
	);

	add_settings_field(
		'track_key',
		__( 'Tracker key', 'automated-sales-tracker' ),
		'as_tracker_field_track_key',
		'automated-sales-tracker',
		'as_tracker_main_section'
	);

	add_settings_field(
		'script_url',
		__( 'Snippet script URL', 'automated-sales-tracker' ),
		'as_tracker_field_script_url',
		'automated-sales-tracker',
		'as_tracker_main_section'
	);
}

function as_tracker_sanitize_settings( $input ) {
	$defaults = as_tracker_default_settings();
	$input    = is_array( $input ) ? $input : array();

	return array(
		'api_url'    => isset( $input['api_url'] ) ? esc_url_raw( trim( $input['api_url'] ) ) : $defaults['api_url'],
		// Not a URL — a per-tenant secret string — so it's sanitized as
		// plain text rather than esc_url_raw().
		'track_key'  => isset( $input['track_key'] ) ? sanitize_text_field( trim( $input['track_key'] ) ) : $defaults['track_key'],
		'script_url' => isset( $input['script_url'] ) ? esc_url_raw( trim( $input['script_url'] ) ) : $defaults['script_url'],
	);
}

function as_tracker_field_api_url() {
	$settings = as_tracker_get_settings();
	printf(
		'<input type="text" class="regular-text code" name="%1$s[api_url]" value="%2$s" placeholder="https://journey-api.yourdomain.com/t/acme-co" />
		<p class="description">%3$s</p>',
		esc_attr( AS_TRACKER_OPTION ),
		esc_attr( $settings['api_url'] ),
		esc_html__( 'The AS_TRACKER_API_URL value — includes the /t/<client-slug> path.', 'automated-sales-tracker' )
	);
}

function as_tracker_field_track_key() {
	$settings = as_tracker_get_settings();
	printf(
		'<input type="text" class="regular-text code" name="%1$s[track_key]" value="%2$s" placeholder="a1b2c3d4..." />
		<p class="description">%3$s</p>',
		esc_attr( AS_TRACKER_OPTION ),
		esc_attr( $settings['track_key'] ),
		esc_html__( 'The AS_TRACKER_KEY value. Treat it like a secret — anyone with it can post tracking events for this client.', 'automated-sales-tracker' )
	);
}

function as_tracker_field_script_url() {
	$settings = as_tracker_get_settings();
	printf(
		'<input type="text" class="regular-text code" name="%1$s[script_url]" value="%2$s" placeholder="https://journey-api.yourdomain.com/automated-sales-tracker.js" />
		<p class="description">%3$s</p>',
		esc_attr( AS_TRACKER_OPTION ),
		esc_attr( $settings['script_url'] ),
		esc_html__( 'The script src URL — same host as the API URL above, one shared file for every client.', 'automated-sales-tracker' )
	);
}

function as_tracker_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	?>
	<div class="wrap">
		<h1><?php echo esc_html( get_admin_page_title() ); ?></h1>
		<?php if ( as_tracker_is_configured() ) : ?>
			<div class="notice notice-success">
				<p><?php esc_html_e( 'Tracker is configured and will load on every front-end page.', 'automated-sales-tracker' ); ?></p>
			</div>
		<?php else : ?>
			<div class="notice notice-warning">
				<p><?php esc_html_e( 'Fill in all three fields below to start tracking — nothing loads until they\'re all set.', 'automated-sales-tracker' ); ?></p>
			</div>
		<?php endif; ?>
		<form action="options.php" method="post">
			<?php
			settings_fields( 'as_tracker_settings_group' );
			do_settings_sections( 'automated-sales-tracker' );
			submit_button( __( 'Save settings', 'automated-sales-tracker' ) );
			?>
		</form>
		<p>
			<?php
			printf(
				/* translators: %s: form-email auto-detection note */
				esc_html__( 'Forms with an email field are picked up automatically once this is configured — %s', 'automated-sales-tracker' ),
				esc_html__( 'no extra setup needed for most WordPress forms (Contact Form 7, WPForms, Gravity Forms, native HTML forms). For anything that doesn\'t submit a native HTML form (Calendly embeds, custom JS widgets), call window.ASTracker.identify(email) manually on success.', 'automated-sales-tracker' )
			);
			?>
		</p>
	</div>
	<?php
}

/**
 * Front-end output: enqueue the shared snippet in the footer (so it never
 * blocks page render) with the two config values attached as an inline
 * script that WordPress prints immediately before it — the same two
 * variables + <script src> pattern as the raw <script> block in the main
 * project README, just generated from the saved settings instead of
 * hand-edited per site.
 */
add_action( 'wp_enqueue_scripts', 'as_tracker_enqueue_snippet' );
function as_tracker_enqueue_snippet() {
	if ( is_admin() || ! as_tracker_is_configured() ) {
		return;
	}

	$settings = as_tracker_get_settings();

	wp_enqueue_script(
		'automated-sales-tracker',
		$settings['script_url'],
		array(),
		AS_TRACKER_VERSION,
		true
	);

	$inline_config = sprintf(
		'window.AS_TRACKER_API_URL = %s; window.AS_TRACKER_KEY = %s;',
		wp_json_encode( $settings['api_url'] ),
		wp_json_encode( $settings['track_key'] )
	);
	wp_add_inline_script( 'automated-sales-tracker', $inline_config, 'before' );
}

/**
 * Small "Settings" link on the Plugins list page, next to Activate/Deactivate.
 */
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), 'as_tracker_settings_link' );
function as_tracker_settings_link( $links ) {
	$settings_link = '<a href="' . esc_url( admin_url( 'options-general.php?page=automated-sales-tracker' ) ) . '">' . esc_html__( 'Settings', 'automated-sales-tracker' ) . '</a>';
	array_unshift( $links, $settings_link );
	return $links;
}
