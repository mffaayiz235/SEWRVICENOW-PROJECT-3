// File: CarReservation.js (Script Include)
var CarReservation = Class.create();
CarReservation.prototype = {
  initialize: function() {},

  /**
   * Reserve a stock record for a booking
   * @param {String} stockSysId - sys_id of u_car_stock
   * @param {String} bookingSysId - sys_id of booking record
   * @returns {Boolean}
   */
  reserve: function(stockSysId, bookingSysId) {
    try {
      var gr = new GlideRecord('u_car_stock');
      if (gr.get(stockSysId)) {
        if (gr.u_status == 'Available') {
          gr.u_status = 'Reserved';
          gr.u_reservation_ref = bookingSysId;
          gr.update();
          return true;
        }
      }
    } catch (e) {
      gs.error('CarReservation.reserve error: ' + e.message);
    }
    return false;
  },

  /**
   * Release a reservation (used when booking cancelled/failed)
   */
  release: function(stockSysId) {
    var gr = new GlideRecord('u_car_stock');
    if (gr.get(stockSysId)) {
      gr.u_status = 'Available';
      gr.u_reservation_ref = '';
      gr.update();
      return true;
    }
    return false;
  },

  type: 'CarReservation'
};


// File: scripted_rest_available_models.js (Scripted REST API - processor)
(function process(request, response) {
  var showId = request.queryParams.showroom;
  var result = [];
  var m = new GlideRecord('u_car_model');
  m.addQuery('u_active', true);
  m.query();
  while (m.next()) {
    // count available stock for model in a showroom if showroom provided
    var availableCount = 0;
    if (showId) {
      var s = new GlideAggregate('u_car_stock');
      s.addQuery('u_model', m.sys_id);
      s.addQuery('u_showroom_location', showId);
      s.addQuery('u_status', 'Available');
      s.addAggregate('COUNT');
      s.query();
      if (s.next())
        availableCount = parseInt(s.getAggregate('COUNT'), 10);
    }
    result.push({
      sys_id: m.sys_id.toString(),
      name: m.u_model_name.toString(),
      available_in_showroom: availableCount
    });
  }
  response.setStatus(200);
  response.setBody(JSON.stringify(result));
})(request, response);


// File: catalog_item_client.js (Catalog Item Client Script - onChange / onSubmit / reset)
// This script assumes variables have names: car_make, car_model, variant, request_type, preferred_date
function onChange(control, oldValue, newValue, isLoading) {
  if (isLoading) return;
  // when car_make changes, clear model & variant
  if (control.name == 'car_make') {
    g_form.setValue('car_model', '');
    g_form.setValue('variant', '');
    // optionally call server to fetch models for make
  }
  if (control.name == 'car_model') {
    g_form.setValue('variant', '');
    // fetch variants for model via GlideAjax if needed
  }
}

// Reset button handler – attach to a UI Action that calls this client function
function resetCatalogForm() {
  var vars = ['car_make','car_model','variant','request_type','preferred_date','customer_name','contact_number'];
  vars.forEach(function(v){
    try { g_form.setValue(v, ''); } catch(e) {}
  });
  // Clear messages
  g_form.clearMessages();
}

// onSubmit validation
function onSubmit() {
  var reqType = g_form.getValue('request_type');
  if (!g_form.getValue('variant')) {
    g_form.showFieldMsg('variant', 'Please select a variant before submitting', 'error');
    return false;
  }
  if (reqType == 'Booking' && !g_form.getValue('preferred_date')) {
    g_form.showFieldMsg('preferred_date', 'Provide preferred delivery/pickup date for booking', 'error');
    return false;
  }
  return true;
}


// File: UIAction_ResetForm_server_side (UI Action for Service Portal)
(function executeRule(current, previous /*null when async*/) {
  // This server-side UI Action returns a small script to call client reset if used in classic UI
  // For Service Portal, implement widget client-side button that triggers resetCatalogForm on client
})(current, previous);


// File: business_rule_reserve_on_insert.js (Business Rule - after insert on u_customer_request for Booking)
(function executeRule(current, previous /*null when async*/) {
  // Only for bookings
  if (current.u_request_type != 'Booking')
    return;

  // find an available stock for requested variant and showroom
  var stockGr = new GlideRecord('u_car_stock');
  stockGr.addQuery('u_variant', current.u_requested_variant);
  if (current.u_showroom)
    stockGr.addQuery('u_showroom_location', current.u_showroom);
  stockGr.addQuery('u_status', 'Available');
  stockGr.query();
  if (stockGr.next()) {
    // call Script Include to reserve
    var reserver = new CarReservation();
    var reserved = reserver.reserve(stockGr.sys_id.toString(), current.sys_id.toString());
    if (reserved) {
      // link stock to request
      current.u_assigned_stock = stockGr.sys_id;
      current.u_status = 'Reserved';
      current.update();

      // create task for inventory to prepare vehicle
      var t = new GlideRecord('task');
      t.initialize();
      t.short_description = 'Prepare vehicle for booking: ' + stockGr.u_vin;
      t.assignment_group = 'u_inventory_manager'; // use real group sys_id in prod
      t.u_related_request = current.sys_id;
      t.insert();
    }
  } else {
    // no stock available – set status and notify
    current.u_status = 'Pending - No stock';
    current.update();
    // optionally create waitlist entry or notify sales
  }
})(current, previous);


// File: GlideAjax_GetVariants.js (GlideAjax Script Include - callable from client to fetch variants for model)
var GetVariants = Class.create();
GetVariants.prototype = Object.extendsObject(AbstractAjaxProcessor, {
  getVariantsForModel: function() {
    var modelId = this.getParameter('sysparm_model');
    var arr = [];
    if (!modelId) return JSON.stringify(arr);
    var gr = new GlideRecord('u_car_variant');
    gr.addQuery('u_model', modelId);
    gr.query();
    while (gr.next()) {
      arr.push({sys_id: gr.sys_id.toString(), name: gr.u_variant_name.toString()});
    }
    return JSON.stringify(arr);
  },
  type: 'GetVariants'
});


/*
README - how to import these snippets into ServiceNow
1. Create Script Includes: CarReservation (Client callable = false), GetVariants (Client callable = true).
2. Create Scripted REST API with the processor code (scripted_rest_available_models.js).
3. Create Catalog Client Script (onChange/onSubmit) for each catalog item and paste catalog_item_client.js logic.
4. Create Business Rule (After Insert) on u_customer_request using business_rule_reserve_on_insert.js.
5. Create UI Action or Service Portal widget for Reset form that calls resetCatalogForm() client function.
6. Adjust table/field names and ACLs to match your instance schema.
*/