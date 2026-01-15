module.exports = async function (context, req) {
    const name = req.query.name || 'World';

    context.res = {
        body: { message: `Hello ${name}` }
    };
};
