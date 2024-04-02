module.exports = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};
