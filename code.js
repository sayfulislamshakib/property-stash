figma.showUI(__html__, { width: 300, height: 500, themeColors: true });

function extractComponentData(node) {
  if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') return null;
  const parent = node.parent;
  const componentSet = (node.type === 'COMPONENT' && parent && parent.type === 'COMPONENT_SET') ? parent : node;
  const compProps = componentSet.componentPropertyDefinitions || node.componentPropertyDefinitions;
  if (!compProps) return null;

  let variantPropsObj = {};
  if (node.type === 'COMPONENT' && parent && parent.type === 'COMPONENT_SET') {
    node.name.split(',').forEach(part => {
      const [k, v] = part.split('=');
      if (k && v) variantPropsObj[k.trim()] = v.trim();
    });
  }

  const props = {};
  let hasValidProps = false;
  for (const [key, def] of Object.entries(compProps)) {
    const cleanKey = key.split('#')[0];
    if (def.type === 'VARIANT') {
      props[cleanKey] = variantPropsObj[cleanKey] !== undefined ? variantPropsObj[cleanKey] : def.defaultValue;
      hasValidProps = true;
    } else if (def.type === 'BOOLEAN') {
      props[cleanKey] = def.defaultValue;
      hasValidProps = true;
    }
  }

  if (!hasValidProps) return null;

  return {
    compKey: componentSet.key || componentSet.id,
    compName: componentSet.name,
    properties: props
  };
}

async function emitSelection() {
  const selectionData = figma.currentPage.selection
    .map(extractComponentData)
    .filter(Boolean);
  figma.ui.postMessage({ type: 'selection-changed', selectionData });
}

figma.on('selectionchange', emitSelection);

let emitTimeout;
figma.loadAllPagesAsync().then(() => {
  figma.on('documentchange', (event) => {
    if (event.documentChanges.some(c => c.type === 'PROPERTY_CHANGE')) {
      clearTimeout(emitTimeout);
      emitTimeout = setTimeout(emitSelection, 150);
    }
  });
});

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ui-ready') {
    const savedStr = await figma.clientStorage.getAsync('remember_properties_data');
    figma.ui.postMessage({ type: 'init-data', savedProps: savedStr ? JSON.parse(savedStr) : {} });
    emitSelection();
  }

  if (msg.type === 'save-properties') {
    const sel = figma.currentPage.selection;
    if (sel.length !== 1) return figma.notify("Please select a single Main Component or Component Set.");

    const data = extractComponentData(sel[0]);
    if (!data) return figma.notify("Selected component has no variant or boolean properties.");

    const savedStr = await figma.clientStorage.getAsync('remember_properties_data');
    const savedData = savedStr ? JSON.parse(savedStr) : {};

    savedData[data.compKey] = {
      name: data.compName,
      properties: data.properties,
      timestamp: Date.now()
    };

    await figma.clientStorage.setAsync('remember_properties_data', JSON.stringify(savedData));
    figma.ui.postMessage({ type: 'data-updated', savedProps: savedData });
    figma.notify("Properties saved successfully!");
  }

  if (msg.type === 'apply-properties') {
    const { compKey, properties } = msg;
    const sel = figma.currentPage.selection;
    if (sel.length === 0) return figma.notify("Please select a Main Component to apply properties to.");

    let appliedCount = 0;
    for (const node of sel) {
      if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
        const parent = node.parent;
        const componentSet = (node.type === 'COMPONENT' && parent && parent.type === 'COMPONENT_SET') ? parent : node;
        const compProps = componentSet.componentPropertyDefinitions;

        if (compProps) {
          // Update Default Values for Booleans
          for (const [key, val] of Object.entries(properties)) {
            const defEntry = Object.entries(compProps).find(([defKey]) => defKey.split('#')[0] === key);
            if (defEntry) {
              const [fullKey, def] = defEntry;
              if (def.type === 'BOOLEAN' || def.type === 'TEXT' || def.type === 'INSTANCE_SWAP') {
                try { componentSet.editComponentProperty(fullKey, { defaultValue: val }); } catch (e) { }
              }
            }
          }

          // Update Component Name (variant combinations)
          if (node.type === 'COMPONENT' && parent && parent.type === 'COMPONENT_SET') {
            const variantPropsObj = {};
            node.name.split(',').forEach(part => {
              const [k, v] = part.split('=');
              if (k && v) variantPropsObj[k.trim()] = v.trim();
            });

            let nameChanged = false;
            for (const [key, val] of Object.entries(properties)) {
              if (Object.entries(compProps).find(([defKey, def]) => defKey.split('#')[0] === key && def.type === 'VARIANT')) {
                variantPropsObj[key] = val;
                nameChanged = true;
              }
            }
            if (nameChanged) node.name = Object.entries(variantPropsObj).map(([k, v]) => `${k}=${v}`).join(', ');
          }
          appliedCount++;
        }
      }
    }
    figma.notify(appliedCount > 0 ? `Applied to ${appliedCount} node(s).` : "No matching components found to apply to.");
  }

  if (msg.type === 'delete-properties') {
    const savedStr = await figma.clientStorage.getAsync('remember_properties_data');
    if (savedStr) {
      const savedData = JSON.parse(savedStr);
      if (savedData[msg.compKey]) {
        delete savedData[msg.compKey];
        await figma.clientStorage.setAsync('remember_properties_data', JSON.stringify(savedData));
        figma.ui.postMessage({ type: 'data-updated', savedProps: savedData });
        figma.notify("Saved properties deleted.");
      }
    }
  }

  if (msg.type === 'import-data') {
    if (typeof msg.data !== 'object' || msg.data === null) {
      return figma.notify("Invalid import file format.");
    }
    const savedStr = await figma.clientStorage.getAsync('remember_properties_data');
    const savedData = savedStr ? JSON.parse(savedStr) : {};

    // Merge new data over old data
    const newData = Object.assign({}, savedData, msg.data);

    await figma.clientStorage.setAsync('remember_properties_data', JSON.stringify(newData));
    figma.ui.postMessage({ type: 'data-updated', savedProps: newData });
    figma.notify("Stash imported successfully!");
  }

  if (msg.type === 'notify') {
    figma.notify(msg.text);
  }
};